# Gemini Voice Library and Character Casting Verification

Narratum was previously named OpenReader; paths and historical comments may still use the older name. This guide covers the Gemini 3.8 dynamic Voice Library used by the `drama-gemini-tts` Audio Drama profile.

## Automated coverage

Run these checks from the project root before merging a staging change:

```bash
pnpm exec vitest run tests/unit/gemini-voice-catalog-client.vitest.spec.ts tests/unit/gemini-voice-catalog-cache.vitest.spec.ts tests/unit/gemini-cast-helpers.vitest.spec.ts tests/unit/gemini-voice-matching.vitest.spec.ts tests/unit/gemini-tts-client.vitest.spec.ts tests/unit/drama-cloud-request.vitest.spec.ts --testTimeout=15000
pnpm tsc --noEmit
git diff --check
```

The existing Playwright suite is intentionally safe for this feature: it runs with test credentials and does not make a live Gemini Voice or TTS request. Run it after producing the standalone app build:

```bash
pnpm exec playwright test --project=chromium
```

## Manual staging smoke test

Use a non-production document and a `drama-gemini-tts` profile that has a valid Gemini API key. A preview is billable and may consume quota.

1. Open **Gemini Drama Cast** for the document.
2. Confirm the Voice Library loads and displays `live`, `cache`, `snapshot`, or the clearly labelled emergency fallback source. The browser must never receive the API key.
3. Select a metadata-rich voice, save the cast, close it, and reopen it. The assignment must persist.
4. Choose **Voice only** preview twice. Both responses should be WAV audio; the second response should contain `X-Narratum-Preview-Cache: HIT`.
5. Try a character and scene preview. They should preserve the typed sample text while applying only the selected delivery mode.
6. Temporarily use a saved ID that is absent from the resolved catalog. Saving must identify it as unassigned instead of silently replacing it.

Do not perform a live smoke request against production credentials until the operator has accepted the possible Gemini cost and quota impact.