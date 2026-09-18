import asyncio
import math
import time
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


def is_gemini_capacity_error(error: Exception) -> bool:
    message = str(error).lower()
    return any(token in message for token in ("429", "quota", "rate limit", "503"))


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
) -> tuple[T, str] | None:
    """Try each model across configured keys with doubling backoff, equilibrium recovery, and fallback models."""
    keys = list(dict.fromkeys(key.strip() for key in api_keys if key and key.strip()))
    if not keys or not models:
        return None

    for model in models:
        key_index = 0
        is_first_attempt = True
        while True:
            api_key = keys[key_index]
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
                # Equilibrium pacing: only on initial request entry, ensure at least current_delay has elapsed
                if is_first_attempt:
                    is_first_attempt = False
                    current_delay = int(api_state.get("current_delay", 0) or 0)
                    last_time = float(api_state.get("last_attempt_time", 0.0) or 0.0)
                    now = time.time()
                    elapsed = now - last_time if last_time > 0 else float(current_delay)
                    needed_wait = float(current_delay) - elapsed
                    if needed_wait > 0:
                        if max_in_flight_delay is not None and needed_wait > max_in_flight_delay:
                            print(f"  -> [⚠️] Model {model} equilibrium wait ({needed_wait:.1f}s) exceeds in-flight limit ({max_in_flight_delay}s). Advancing to fallback model...")
                            break
                        print(f"  -> [⏳] Rate Limiter Pacing: Pausing for {needed_wait:.1f}s equilibrium delay ({model})...")
                        await sleep_fn(needed_wait)

                api_state["last_attempt_time"] = time.time()

                try:
                    response = await request(api_key, model)
                except Exception as error:
                    if not is_gemini_capacity_error(error):
                        raise

                    # Capacity error (429 or 503)
                    # If we have another key (e.g. backup key) that hasn't been tried yet in this round:
                    if len(keys) > 1 and key_index < len(keys) - 1:
                        curr = int(api_state.get("current_delay", 0) or 0)
                        api_state["current_delay"] = min_delay if curr == 0 else min(curr * 2, max_delay)
                        api_state["resume_at"] = time.time() + api_state["current_delay"]
                        print(f"  -> [🔄] Primary API Limit Hit ({model})! Trying backup key...")
                        key_index += 1
                        continue

                    # Reset key_index to 0 for next retry attempt
                    key_index = 0

                    curr = int(api_state.get("current_delay", 0) or 0)
                    next_delay = min_delay if curr == 0 else min(curr * 2, max_delay)
                    api_state["current_delay"] = next_delay
                    api_state["resume_at"] = time.time() + next_delay

                    print(f"  -> [🛑] API Limit Hit ({model})! Spiking cooldown to {next_delay} seconds.")

                    if max_in_flight_delay is not None and next_delay > max_in_flight_delay:
                        print(f"  -> [⚠️] Model {model} cooldown ({next_delay}s) exceeds in-flight limit ({max_in_flight_delay}s). Advancing to fallback model...")
                        break

                    if next_delay >= max_delay:
                        consecutive = int(api_state.get("consecutive_max_delays", 0) or 0) + 1
                        api_state["consecutive_max_delays"] = consecutive
                        if consecutive > max_top_delays:
                            print(f"  -> [⚠️] Model {model} exceeded {max_top_delays} consecutive {max_delay}s waits. Advancing to fallback model...")
                            api_state["consecutive_max_delays"] = 0
                            break
                        print(f"  -> [⏳] Waiting {next_delay}s (Wait {consecutive}/{max_top_delays} at max delay)...")
                    else:
                        print(f"  -> [⏳] Waiting {next_delay}s before retrying {model}...")

                    await sleep_fn(next_delay)
                    api_state["last_attempt_time"] = time.time()
                    continue

                # SUCCESS! Step the delay back down gracefully to find equilibrium
                curr = int(api_state.get("current_delay", 0) or 0)
                if curr > 0:
                    reduced = curr // 2
                    api_state["current_delay"] = reduced if reduced >= min_delay else 0
                    print(f"  -> [✅] API Recovering ({model}): Cooldown reduced to {api_state['current_delay']} seconds.")
                api_state["resume_at"] = 0
                api_state["consecutive_max_delays"] = 0
                return response, model

    return None
