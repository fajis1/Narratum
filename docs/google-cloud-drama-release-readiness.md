# Google Cloud Drama Release Readiness

This document records the Stage 14 test matrix and deployment notes for the
`drama-gemini-tts` Smart Audio mode.

## Regression matrix

| Area | Coverage | Result |
| --- | --- | --- |
| Existing Kokoro multi voice behavior | `tests/unit/multi-voice.vitest.spec.ts` and the full Vitest suite | Pass |
| Cloud voice catalog and cast readiness | `tests/unit/google-cloud-cast.vitest.spec.ts` | Pass |
| Service account and ADC credential handling | `tests/unit/google-cloud-auth.vitest.spec.ts` | Pass |
| Cloud TTS request validation and byte limits | `tests/unit/google-cloud-tts-client.vitest.spec.ts`, `drama-cloud-request.vitest.spec.ts` | Pass |
| Director schema, prompt grounding, and exact text preservation | `drama-director-schema.vitest.spec.ts`, `drama-director.vitest.spec.ts` | Pass |
| Chunk retries, failed line retention, and MP3 placeholders | `drama-cloud-synthesis.vitest.spec.ts`, `segmented-audiobook-tts.vitest.spec.ts` | Pass |
| End-to-end chapter orchestration and persisted review flags | `cloud-drama-orchestration.vitest.spec.ts`, `document-settings.vitest.spec.ts` | Pass |
| Cast direction UI, previews, and listening-page recovery wiring | `drama-character-direction.vitest.spec.ts`, `multi-voice.vitest.spec.ts` | Pass |
| Full repository unit suite | `pnpm test:unit` | 171 files, 1,278 tests passed |

Additional release gates passed on the staging branch:

- `pnpm tsc --noEmit`
- `git diff --check`

Live Google Cloud synthesis, real credentials, browser interaction, and
production storage are not covered by the automated suite. Run those checks in
the Listenary staging deployment before promoting the feature.

## Migration and compatibility

No database migration is required. Cloud cast direction and review flags are
stored inside the existing per-document `documentSettings.dataJson` JSON
object. Existing rows remain valid because both fields are optional and the
normalizer preserves unknown older settings safely.

Existing Smart Audio profiles remain compatible. The new
`drama-gemini-tts` worker mode is opt-in, and existing Standard, Scholar,
Bibliography Catcher, and Kokoro Audio Drama profiles continue using their
existing provider and voice validation paths.

For a deployment using a service account, create a Google Cloud TTS-enabled
service account and paste its JSON into the Cloud Drama profile once. The raw
JSON is write-only in the UI; profile reads expose only the configured account
email. If no profile credential is stored, the server may use Application
Default Credentials. The Cloud TTS API and the `gemini-3.1-flash-tts-preview`
model must be enabled for that project.

## Rollout checklist

1. Deploy the Listenary `main` build containing the staging commits.
2. Configure one Cloud Drama profile with a test credential or ADC.
3. Scan a short document, assign Cloud voices, and play one voice preview.
4. Generate one short chapter and confirm failed lines create visible review
   flags rather than disappearing.
5. Use the listening-page recovery panel to retry a flagged chapter and mark a
   resolved flag.
6. Confirm existing Kokoro Drama and Standard audiobook generation still work.
7. Revoke the test credential after the smoke test if it was created solely for
   rollout verification.

## Known limits

- No live Cloud credential was available during repository verification.
- Browser smoke tests were not run in this environment.
- Stage 14 verifies code and migration readiness; operational Cloud quota,
  IAM, latency, and audio quality still require deployment-specific testing.
