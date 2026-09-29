# Gemini Voice Library and Character Casting Verification

Narratum was previously named OpenReader; paths and historical comments may still use the older name. This guide covers the Gemini 3.8 dynamic Voice Library used by the `drama-gemini-tts` Audio Drama profile.


## September 2026 follow-up behavior

- The server makes one fixed `v1beta/voices` request scope for prebuilt voices and filters all English variants (`en` and `en-*`) locally. It must not reintroduce upstream `en-US`/`en-GB` filtering.
- The in-memory catalog cache is credential-fingerprinted (the raw key is never retained in cache keys or logs); the durable public snapshot is last-known-good only. If refresh fails, the UI can continue with a snapshot while showing a safe authentication, permission, rate-limit, or availability notice.
- Gemini Drama validation, queueing, chapter generation, and synthesis all use the dynamic catalog. The former featured-30 list is only an explicit emergency fallback, never normal assignment authority.
- Manual selection writes `assignmentSource: user` with bounded public catalog metadata. Recommendations and automatic minor-character assignment do not overwrite it.
- Voice-only previews ignore manuscript/typed text, use the fixed comparison line with `gemini-3.8-flash-lite-tts`, and share a bounded process cache by public voice/model/version. Character and scene previews remain private to their user/document context.

## Automated coverage

Run these checks from the project root before merging a staging change:

```bash
pnpm exec vitest run tests/unit/gemini-voice-catalog-client.vitest.spec.ts tests/unit/gemini-voice-catalog-cache.vitest.spec.ts tests/unit/gemini-cast-helpers.vitest.spec.ts tests/unit/gemini-voice-matching.vitest.spec.ts tests/unit/gemini-tts-client.vitest.spec.ts tests/unit/drama-cloud-request.vitest.spec.ts tests/unit/gemini-voice-library-ui.vitest.spec.ts --testTimeout=15000
pnpm tsc --noEmit
git diff --check
```

The existing Playwright suite is intentionally safe for this feature: it runs with test credentials and does not make a live Gemini Voice or TTS request. Run it after producing the standalone app build:

```bash
PLAYWRIGHT_WORKERS=1 pnpm exec playwright test tests/gemini-voice-library.spec.ts --project=chromium
```

`gemini-voice-library.spec.ts` is a browser-level mocked workflow. It intercepts the Narratum preview route and does not contact Gemini. It covers metadata filters (including pitch and dynamic context), recommendation display and explicit acceptance, voice-only preview initiation, saved in-use state, and the emergency fallback retaining an extended saved ID.

## Manual staging smoke test

Use a non-production document and a `drama-gemini-tts` profile that has a valid Gemini API key. A preview is billable and may consume quota.

1. Open **Gemini Drama Cast** for the document.
2. Confirm the Voice Library loads all available English prebuilt voices and displays its `live`, `cache`, `snapshot`, or clearly labelled emergency fallback source. A failed refresh must show its safe status notice; the browser must never receive the API key.
3. Search/filter the library, select a metadata-rich voice, save the cast, close it, and reopen it. The manual assignment and its public snapshot must persist; automatic/recommended assignment must not replace it.
4. Choose **Voice only** preview twice (even with different typed preview text). Both responses should be WAV audio using the standard comparison line and Flash-Lite; the second response should contain `X-Narratum-Preview-Cache: HIT`.
5. Try a character and scene preview. They should preserve the typed sample text while applying only the selected delivery mode.
6. Temporarily use a saved ID that is absent from the resolved catalog. Saving must identify it as unassigned instead of silently replacing it.

Do not perform a live smoke request against production credentials until the operator has accepted the possible Gemini cost and quota impact.