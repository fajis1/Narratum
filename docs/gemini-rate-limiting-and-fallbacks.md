# Gemini Rate Limiting, Backoff, and Model Fallbacks

This document outlines the rate limiting, backoff, and model fallback architecture in OpenReader's Python workers and TypeScript background job scheduler.

## Problem Context

Google Gemini enforces rate limits across two distinct tiers:
1. **Requests Per Minute (RPM) & Tokens Per Minute (TPM)**: Transient burst limits (e.g. 15 RPM on free tier, 1000 RPM on paid tier). These require pacing and exponential backoff of seconds to minutes.
2. **Requests Per Day (RPD) & Spending Caps**: Daily quota exhaustion that resets at midnight Pacific Time.

If an RPM burst limit triggers an immediate 24-hour job lockout, audiobooks stall unnecessarily on transient 429 responses. Conversely, hammering an exhausted quota burns CPU and network bandwidth.

## Pacing and Backoff Architecture

Rate limiting is coordinated via `gemini_rate_limiter.py` (`call_gemini_with_capacity_fallback`):

### 1. Exponential Doubling Backoff
- Initial delay begins at `MIN_DELAY = 5` seconds.
- On receiving HTTP `429` (Too Many Requests / Resource Exhausted) or `503` (Service Unavailable), the delay doubles:
  $$5\text{s} \rightarrow 10\text{s} \rightarrow 20\text{s} \rightarrow 40\text{s} \rightarrow 80\text{s} \rightarrow 160\text{s} \rightarrow 300\text{s} \ (\text{capped at } \texttt{MAX\_DELAY} = 300\text{s})$$
- The worker sleeps for the calculated delay and retries the request rather than aborting.

### 2. Multi-Key Fallback
- If a secondary (`backup_api_key`) is configured, a capacity error on the primary key immediately attempts the backup key before any sleep delay is incurred.
- If both keys hit capacity errors, the delay doubles and the worker pauses.

### 3. Three 300-Second Waits Before Model Exhaustion
- When the exponential delay reaches the 300-second (5-minute) cap, the worker allows up to **3 consecutive 300-second waits** (`max_top_delays = 3`).
- If the model continues to fail after the third 300-second wait, that specific model is deemed exhausted for the current job pass.

### 4. Fallback Models Progression
- When the primary model (e.g. `gemini-3.8-flash`) exhausts its retry budget, the worker does **not** pause the audiobook.
- Instead, it falls back to the configured fallback models in order (e.g. `gemini-3.7-flash`, then `gemini-3.6-flash`).
- Each fallback model begins with a fresh attempt and its own backoff cycle.

### 5. Equilibrium Downshifting
- Upon receiving a successful response from Gemini, the active delay steps down by half:
  $$\text{current\_delay} = \lfloor\text{current\_delay} / 2\rfloor$$
- If the reduced delay falls below `MIN_DELAY`, it resets to `0`.
- Inter-request pacing ensures that successive requests on that key/model are spaced by at least `current_delay` seconds. This gradually settles into an equilibrium request rate that matches Google's active rate limit.

### 6. The 24-Hour Queue Hold (Final Resort)
- Only when **all configured models** (primary + all fallbacks) and all keys have exhausted their retries does `call_gemini_with_capacity_fallback` return `None`.
- The worker responds with `status: "rate_limit"`.
- The Node.js queue runner stamps the job with `error: GEMINI_RATE_LIMIT_PAUSE_MESSAGE`.
- The database scheduler excludes the job for 24 hours (`RATE_LIMIT_BACKOFF_MS = 24 * 60 * 60 * 1000`) or until the user manually clicks **Resume** in the UI.
## 2026-09-22 — Foreign-word prescan model controls

The foreign-word pronunciation prescan is configured at two levels:

- Smart Audio Settings persist the pronunciation primary model and up to two ordered fallback models.
- The **Foreign Word Pronunciation & Definition Pre-Scan** modal exposes a per-scan **Pronunciation model** selector and expandable **Fallbacks** selectors. Those request-level values override the profile defaults for that scan.

The prescan sends the selected chain through `fetchGeminiWithRateLimitFallback`. The normal 3.8 → 3.7 → 3.6 chain is available in the prescan UI, while authentication/invalid-request failures are not blindly model-hopped. Prescan overrides are per-scan and are not stored as an independent prescan preference.
