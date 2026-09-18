import unittest
from pathlib import Path

from gemini_rate_limiter import (
    call_gemini_with_capacity_fallback,
    extract_gemini_usage,
    ordered_gemini_models,
    refresh_gemini_cooldown,
)


class GeminiRateLimiterTests(unittest.TestCase):
    def test_usage_metadata_is_normalized_without_prompt_content(self):
        class Usage:
            prompt_token_count = 120
            candidates_token_count = 80
            thoughts_token_count = 10
            cached_content_token_count = 70
            total_token_count = 210

        class Response:
            usage_metadata = Usage()

        self.assertEqual(extract_gemini_usage(Response()), {
            "inputTokens": 120,
            "outputTokens": 80,
            "thinkingTokens": 10,
            "cachedInputTokens": 70,
            "totalTokens": 210,
        })

    def test_active_cooldown_is_preserved_and_reported(self):
        state = {"current_delay": 40, "resume_at": 140}

        remaining = refresh_gemini_cooldown(state, now=100)

        self.assertEqual(remaining, 40)
        self.assertEqual(state, {"current_delay": 40, "resume_at": 140})

    def test_fractional_remaining_time_rounds_up(self):
        state = {"current_delay": 40, "resume_at": 100.2}

        remaining = refresh_gemini_cooldown(state, now=100)

        self.assertEqual(remaining, 1)

    def test_expired_cooldown_is_cleared_for_a_probe(self):
        state = {"current_delay": 40, "resume_at": 100}

        remaining = refresh_gemini_cooldown(state, now=100)

        self.assertEqual(remaining, 0)
        self.assertEqual(state, {"current_delay": 0, "resume_at": 0})

    def test_in_request_delay_without_resume_time_is_unchanged(self):
        state = {"current_delay": 10, "resume_at": 0}

        remaining = refresh_gemini_cooldown(state, now=100)

        self.assertEqual(remaining, 0)
        self.assertEqual(state, {"current_delay": 10, "resume_at": 0})

    def test_both_smart_audio_workers_use_capacity_fallbacks(self):
        repository_root = Path(__file__).resolve().parents[2]

        for worker_name in ("audiobook_worker.py", "biblical_scholar_worker.py"):
            source = (repository_root / worker_name).read_text(encoding="utf-8")
            self.assertIn(
                "call_gemini_with_capacity_fallback(",
                source,
                worker_name,
            )

    def test_model_order_is_trimmed_deduplicated_and_limited(self):
        self.assertEqual(
            ordered_gemini_models(" primary ", ["backup-1", "backup-1", "backup-2", "backup-3"]),
            ["primary", "backup-1", "backup-2"],
        )

    def test_docker_image_includes_workers_and_shared_limiter(self):
        repository_root = Path(__file__).resolve().parents[2]
        dockerfile = (repository_root / "Dockerfile").read_text(encoding="utf-8")

        for filename in (
            "audiobook_worker.py",
            "biblical_scholar_worker.py",
            "gemini_rate_limiter.py",
        ):
            self.assertIn(f"/app/{filename} ./{filename}", dockerfile, filename)


class GeminiCapacityFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_advances_to_next_model_after_capacity_error(self):
        attempts = []
        slept_delays = []

        async def mock_sleep(seconds):
            slept_delays.append(seconds)

        async def request(api_key, model):
            attempts.append((api_key, model))
            if model == "primary":
                raise RuntimeError("429 quota exceeded")
            return "success"

        result = await call_gemini_with_capacity_fallback(
            api_states={},
            api_keys=["key"],
            models=["primary", "backup"],
            request=request,
            min_delay=5,
            max_delay=300,
            max_top_delays=3,
            sleep_fn=mock_sleep,
        )

        self.assertEqual(result, ("success", "backup"))
        # Primary failed 1 initial + 6 doublings (5, 10, 20, 40, 80, 160) + 3 waits at 300s = 10 attempts on primary
        self.assertEqual(len([a for a in attempts if a[1] == "primary"]), 10)
        self.assertEqual(slept_delays, [5, 10, 20, 40, 80, 160, 300, 300, 300])
        self.assertIn(("key", "backup"), attempts)

    async def test_exponential_doubling_and_three_300s_waits(self):
        delays = []

        async def mock_sleep(seconds):
            delays.append(seconds)

        async def request(api_key, model):
            raise RuntimeError("429 Too Many Requests")

        result = await call_gemini_with_capacity_fallback(
            api_states={},
            api_keys=["key"],
            models=["only-model"],
            request=request,
            min_delay=5,
            max_delay=300,
            max_top_delays=3,
            sleep_fn=mock_sleep,
        )

        self.assertIsNone(result)
        # Verify exact exponential sequence up to 300, then 3 waits at 300
        self.assertEqual(delays, [5, 10, 20, 40, 80, 160, 300, 300, 300])

    async def test_gradual_downshift_and_equilibrium(self):
        delays = []

        async def mock_sleep(seconds):
            delays.append(seconds)

        api_states = {}

        # First call hits 429 once, then succeeds on retry
        call_count = 0
        async def request_one(api_key, model):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("429 Too Many Requests")
            return "ok"

        res1 = await call_gemini_with_capacity_fallback(
            api_states=api_states,
            api_keys=["key"],
            models=["model"],
            request=request_one,
            min_delay=5,
            max_delay=300,
            sleep_fn=mock_sleep,
        )
        self.assertEqual(res1, ("ok", "model"))
        # Started at 0, hit 429, spiked to 5s, slept 5s, retried and succeeded.
        # On success, delay 5 was reduced by // 2 to 2 (< 5 min_delay), so 0.
        state = api_states[("key", "model")]
        self.assertEqual(state["current_delay"], 0)

        # Now simulate a higher delay (e.g. 80s) to test gradual downshift
        state["current_delay"] = 80
        state["last_attempt_time"] = 0.0

        async def request_success(api_key, model):
            return "ok"

        # Next successful call downshifts 80 -> 40
        await call_gemini_with_capacity_fallback(
            api_states=api_states,
            api_keys=["key"],
            models=["model"],
            request=request_success,
            min_delay=5,
            max_delay=300,
            sleep_fn=mock_sleep,
        )
        self.assertEqual(state["current_delay"], 40)

        # Next successful call downshifts 40 -> 20
        state["last_attempt_time"] = 0.0
        await call_gemini_with_capacity_fallback(
            api_states=api_states,
            api_keys=["key"],
            models=["model"],
            request=request_success,
            min_delay=5,
            max_delay=300,
            sleep_fn=mock_sleep,
        )
        self.assertEqual(state["current_delay"], 20)

        # Next successful call downshifts 20 -> 10
        state["last_attempt_time"] = 0.0
        await call_gemini_with_capacity_fallback(
            api_states=api_states,
            api_keys=["key"],
            models=["model"],
            request=request_success,
            min_delay=5,
            max_delay=300,
            sleep_fn=mock_sleep,
        )
        self.assertEqual(state["current_delay"], 10)

        # Next successful call downshifts 10 -> 5
        state["last_attempt_time"] = 0.0
        await call_gemini_with_capacity_fallback(
            api_states=api_states,
            api_keys=["key"],
            models=["model"],
            request=request_success,
            min_delay=5,
            max_delay=300,
            sleep_fn=mock_sleep,
        )
        self.assertEqual(state["current_delay"], 5)

        # Next successful call downshifts 5 -> 2 (< min_delay) -> 0
        state["last_attempt_time"] = 0.0
        await call_gemini_with_capacity_fallback(
            api_states=api_states,
            api_keys=["key"],
            models=["model"],
            request=request_success,
            min_delay=5,
            max_delay=300,
            sleep_fn=mock_sleep,
        )
        self.assertEqual(state["current_delay"], 0)

    async def test_backup_key_tried_before_sleep(self):
        attempts = []
        delays = []

        async def mock_sleep(seconds):
            delays.append(seconds)

        async def request(api_key, model):
            attempts.append((api_key, model))
            if api_key == "primary-key":
                raise RuntimeError("429 Too Many Requests")
            return "backup-success"

        result = await call_gemini_with_capacity_fallback(
            api_states={},
            api_keys=["primary-key", "backup-key"],
            models=["model"],
            request=request,
            min_delay=5,
            max_delay=300,
            sleep_fn=mock_sleep,
        )

        self.assertEqual(result, ("backup-success", "model"))
        # Primary failed, backup tried immediately without sleep
        self.assertEqual(attempts, [("primary-key", "model"), ("backup-key", "model")])
        self.assertEqual(delays, [])

    async def test_reports_exhaustion_only_after_every_key_and_model(self):
        attempts = []
        delays = []

        async def mock_sleep(seconds):
            delays.append(seconds)

        async def request(api_key, model):
            attempts.append((api_key, model))
            raise RuntimeError("503 service unavailable")

        result = await call_gemini_with_capacity_fallback(
            api_states={},
            api_keys=["primary-key", "backup-key"],
            models=["model-1", "model-2", "model-3"],
            request=request,
            min_delay=5,
            max_delay=300,
            max_top_delays=1,
            sleep_fn=mock_sleep,
        )

        self.assertIsNone(result)
        # Each model had attempts with primary and backup across the doubling sequence
        self.assertTrue(any(a[1] == "model-1" for a in attempts))
        self.assertTrue(any(a[1] == "model-2" for a in attempts))
        self.assertTrue(any(a[1] == "model-3" for a in attempts))

    async def test_advances_to_fallback_model_when_in_flight_delay_exceeded(self):
        attempts = []
        delays = []

        async def mock_sleep(seconds):
            delays.append(seconds)

        async def request(api_key, model):
            attempts.append((api_key, model))
            if model == "primary":
                raise RuntimeError("429 quota exceeded")
            return "fallback-success"

        result = await call_gemini_with_capacity_fallback(
            api_states={},
            api_keys=["key"],
            models=["primary", "backup"],
            request=request,
            min_delay=5,
            max_delay=300,
            max_in_flight_delay=20,
            sleep_fn=mock_sleep,
        )

        self.assertEqual(result, ("fallback-success", "backup"))
        # Primary retried at 5s, 10s, 20s. On next doubling (40s > 20s), it advanced immediately to backup
        self.assertEqual(delays, [5, 10, 20])
        self.assertEqual([a[1] for a in attempts], ["primary", "primary", "primary", "primary", "backup"])

    async def test_yields_none_when_in_flight_delay_exceeded_on_all_models(self):
        attempts = []
        delays = []

        async def mock_sleep(seconds):
            delays.append(seconds)

        async def request(api_key, model):
            attempts.append((api_key, model))
            raise RuntimeError("429 quota exceeded")

        api_states = {}
        result = await call_gemini_with_capacity_fallback(
            api_states=api_states,
            api_keys=["key"],
            models=["only-model"],
            request=request,
            min_delay=5,
            max_delay=300,
            max_in_flight_delay=20,
            sleep_fn=mock_sleep,
        )

        self.assertIsNone(result)
        # Did not sleep through 40s, 80s, 160s, 300s!
        self.assertEqual(delays, [5, 10, 20])
        # State retains the full spiked delay for subsequent cooldown checks
        state = api_states[("key", "only-model")]
        self.assertEqual(state["current_delay"], 40)

    async def test_skips_model_when_initial_equilibrium_wait_exceeds_in_flight_limit(self):
        delays = []

        async def mock_sleep(seconds):
            delays.append(seconds)

        async def request(api_key, model):
            return f"{model}-ok"

        import time
        # Simulate primary model already in a 300s cooldown from earlier
        api_states = {
            ("key", "primary"): {
                "current_delay": 300,
                "last_attempt_time": time.time(),
            }
        }

        result = await call_gemini_with_capacity_fallback(
            api_states=api_states,
            api_keys=["key"],
            models=["primary", "fallback"],
            request=request,
            min_delay=5,
            max_delay=300,
            max_in_flight_delay=20,
            sleep_fn=mock_sleep,
        )

        # Primary was skipped without sleeping 300s, and fallback succeeded immediately
        self.assertEqual(result, ("fallback-ok", "fallback"))
        self.assertEqual(delays, [])


if __name__ == "__main__":
    unittest.main()

