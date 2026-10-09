import asyncio
import math
import re
import time
from email.utils import parsedate_to_datetime
from typing import Awaitable, Callable, MutableMapping, Sequence, TypeVar


T = TypeVar("T")


def extract_gemini_usage(response: object) -> dict[str, int]:
    """Return non-sensitive Gemini usage counters in a stable JSON shape."""
    metadata = getattr(response, "usage_metadata", None)

    def count(*names: str) -> int:
        for name in names:
            value = getattr(metadata, name, None)
            if isinstance(value, (int, float)):
                return max(0, int(value))
        return 0

    return {
        "inputTokens": count("prompt_token_count"),
        "outputTokens": count("candidates_token_count"),
        "thinkingTokens": count("thoughts_token_count"),
        "cachedInputTokens": count("cached_content_token_count"),
        "totalTokens": count("total_token_count"),
    }


def refresh_gemini_cooldown(
    api_state: MutableMapping[str, object],
    *,
    now: float | None = None,
) -> int:
    """Return remaining cooldown seconds and clear an expired penalty for a probe."""
    current_time = time.time() if now is None else now
    resume_at = float(api_state.get("resume_at", 0) or 0)

    if resume_at <= 0:
        return 0

    remaining = resume_at - current_time
    if remaining > 0:
        return max(1, math.ceil(remaining))

    # The queue has waited out the full penalty. Reset the exponential delay so
    # this attempt reaches Gemini instead of scheduling the same cooldown again.
    api_state["resume_at"] = 0
    api_state["current_delay"] = 0
    return 0


def ordered_gemini_models(primary: str, fallbacks: object, *, limit: int = 2) -> list[str]:
    """Return a trimmed, de-duplicated primary plus at most two fallbacks."""
    models = [primary.strip()] if isinstance(primary, str) and primary.strip() else []
    if isinstance(fallbacks, Sequence) and not isinstance(fallbacks, (str, bytes)):
        for value in fallbacks:
            model = value.strip() if isinstance(value, str) else ""
            if model and model not in models:
                models.append(model)
            if len(models) >= limit + 1:
                break
    return models


def gemini_error_details(error: Exception) -> dict[str, object]:
    """Extract a small, credential-free diagnostic from Google SDK exceptions."""
    status = getattr(error, "code", None)
    if callable(status):
        try:
            status = status()
        except Exception:
            status = None
    status_value = getattr(status, "value", status)
    http_status = status_value if isinstance(status_value, int) else None
    message = str(error)
    match = re.search(r"\b([45]\d{2})\b", message)
    if http_status is None and match:
        http_status = int(match.group(1))
    api_status = getattr(error, "status", None) or getattr(status, "name", None)
    if not isinstance(api_status, str):
        api_status = next((value for value in ("RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE", "DEADLINE_EXCEEDED", "PERMISSION_DENIED", "UNAUTHENTICATED") if value in message.upper()), None)
    retry_after_ms = None
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None) or getattr(error, "headers", None)
    if hasattr(headers, "get"):
        retry_after = headers.get("retry-after") or headers.get("Retry-After")
        if retry_after:
            try:
                retry_after_ms = max(0, int(float(retry_after) * 1000))
            except (ValueError, TypeError):
                try:
                    retry_after_ms = max(0, int((parsedate_to_datetime(retry_after).timestamp() - time.time()) * 1000))
                except (ValueError, TypeError, OverflowError):
                    pass
    message = re.sub(r"AIza[a-zA-Z0-9_-]{20,}|Bearer\s+[^\s,}]+|([?&]key=)[^&\s]+", "[redacted]", message, flags=re.IGNORECASE)
    message = re.sub(r"(api[_-]?key|authorization|token|password)\s*[:=]\s*[^\s,}]+", r"\1=[redacted]", message, flags=re.IGNORECASE)
    return {
        "retryAfterMs": retry_after_ms,
        "httpStatus": http_status,
        "apiStatus": api_status if isinstance(api_status, str) else None,
        "exceptionType": type(error).__name__,
        "message": message[:2000],
    }


def gemini_failure_diagnostic(correlation: dict, model: str, attempts: list[dict], error: Exception | None = None) -> dict:
    last_error = next((attempt for attempt in reversed(attempts) if attempt.get("outcome") == "error"), {})
    details = gemini_error_details(error) if error else {key: last_error.get(key) for key in ("httpStatus", "apiStatus", "exceptionType", "retryAfterMs")}
    return {"schemaVersion": 1, "provider": "gemini", "stage": "smart_audio_cleanup", **correlation,
            "modelRequested": model, "attempts": attempts[-50:], "error": details}


def is_gemini_retryable_error(error: Exception) -> bool:
    details = gemini_error_details(error)
    if details["httpStatus"] in (400, 401, 402, 403, 404, 422):
        return details["httpStatus"] == 403 and details["apiStatus"] == "RESOURCE_EXHAUSTED" and bool(details["retryAfterMs"])
    if isinstance(error, (TimeoutError, ConnectionError)) or type(error).__name__ in ("ConnectTimeout", "ReadTimeout", "WriteTimeout", "PoolTimeout", "ConnectError", "ReadError", "NetworkError"):
        return True
    if details["httpStatus"] in (408, 429, 500, 502, 503, 504):
        return True
    if details["apiStatus"] in ("RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE", "DEADLINE_EXCEEDED"):
        return True
    message = str(details["message"]).lower()
    return any(token in message for token in ("quota", "rate limit", "resource_exhausted", "unavailable"))


# Compatibility for callers outside this repository.
is_gemini_capacity_error = is_gemini_retryable_error


async def call_gemini_with_capacity_fallback(
    *,
    api_states: MutableMapping[object, MutableMapping[str, object]],
    api_keys: Sequence[str],
    models: Sequence[str],
    request: Callable[[str, str], Awaitable[T]],
    min_delay: int,
    max_delay: int,
    max_top_delays: int = 3,
    max_in_flight_delay: int | None = None,
    sleep_fn: Callable[[float], Awaitable[None]] = asyncio.sleep,
    attempt_recorder: Callable[[dict[str, object]], None] | None = None,
) -> tuple[T, str] | None:
    """Exhaust each key's model chain before moving to the next API key."""
    keys = list(dict.fromkeys(key.strip() for key in api_keys if key and key.strip()))
    if not keys or not models:
        return None

    attempt_number = 0
    for key_index, api_key in enumerate(keys):
        for model_index, model in enumerate(models):
            is_first_attempt = True
            while True:
                state_key = (api_key, model)
                api_state = api_states.setdefault(
                    state_key,
                    {
                        "lock": asyncio.Lock(),
                        "current_delay": 0,
                        "resume_at": 0,
                        "consecutive_max_delays": 0,
                        "last_attempt_time": 0.0,
                    },
                )

                lock = api_state.setdefault("lock", asyncio.Lock())
                if not isinstance(lock, asyncio.Lock):
                    lock = asyncio.Lock()
                    api_state["lock"] = lock

                async with lock:
                    if is_first_attempt:
                        is_first_attempt = False
                        current_delay = int(api_state.get("current_delay", 0) or 0)
                        last_time = float(api_state.get("last_attempt_time", 0.0) or 0.0)
                        now = time.time()
                        elapsed = now - last_time if last_time > 0 else float(current_delay)
                        needed_wait = float(current_delay) - elapsed
                        if needed_wait > 0:
                            if max_in_flight_delay is not None and needed_wait > max_in_flight_delay:
                                print(f"  -> [WARN] Model {model} equilibrium wait ({needed_wait:.1f}s) exceeds in-flight limit ({max_in_flight_delay}s). Advancing to fallback model...")
                                break
                            print(f"  -> [WAIT] Rate Limiter Pacing: Pausing for {needed_wait:.1f}s equilibrium delay ({model})...")
                            await sleep_fn(needed_wait)

                    api_state["last_attempt_time"] = time.time()

                    try:
                        response = await request(api_key, model)
                    except Exception as error:
                        details = gemini_error_details(error)
                        if attempt_recorder:
                            attempt_number += 1
                            attempt_recorder({
                                "attempt": attempt_number,
                                "keyType": "primary" if key_index == 0 else "backup",
                                "model": model,
                                "outcome": "error",
                                **details,
                            })
                        if not is_gemini_retryable_error(error):
                            raise

                        curr = int(api_state.get("current_delay", 0) or 0)
                        next_delay = min_delay if curr == 0 else min(curr * 2, max_delay)
                        next_delay = max(next_delay, math.ceil(float(details.get("retryAfterMs") or 0) / 1000))
                        api_state["current_delay"] = next_delay
                        api_state["resume_at"] = time.time() + next_delay
                        print(f"  -> [LIMIT] API retryable error ({model}); cooldown {next_delay} seconds.")

                        if model_index == len(models) - 1 and key_index < len(keys) - 1:
                            print(f"  -> [FALLBACK] Credential model chain exhausted ({model}); trying backup key from its primary model...")
                            break

                        if max_in_flight_delay is not None and next_delay > max_in_flight_delay:
                            print(f"  -> [WARN] Model {model} cooldown ({next_delay}s) exceeds in-flight limit ({max_in_flight_delay}s). Advancing to fallback model...")
                            break

                        if next_delay >= max_delay:
                            consecutive = int(api_state.get("consecutive_max_delays", 0) or 0) + 1
                            api_state["consecutive_max_delays"] = consecutive
                            if consecutive > max_top_delays:
                                print(f"  -> [WARN] Model {model} exceeded {max_top_delays} consecutive {max_delay}s waits. Advancing to fallback model...")
                                api_state["consecutive_max_delays"] = 0
                                break
                            print(f"  -> [WAIT] Waiting {next_delay}s (Wait {consecutive}/{max_top_delays} at max delay)...")
                        else:
                            print(f"  -> [WAIT] Waiting {next_delay}s before retrying {model}...")

                        await sleep_fn(next_delay)
                        api_state["last_attempt_time"] = time.time()
                        continue

                    curr = int(api_state.get("current_delay", 0) or 0)
                    if curr > 0:
                        reduced = curr // 2
                        api_state["current_delay"] = reduced if reduced >= min_delay else 0
                        print(f"  -> [RECOVERED] API recovering ({model}); cooldown reduced to {api_state['current_delay']} seconds.")
                    api_state["resume_at"] = 0
                    api_state["consecutive_max_delays"] = 0
                    return response, model

    return None
