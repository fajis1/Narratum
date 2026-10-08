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
| Audiobook generation UI & modal integration | `google-cloud-cast.vitest.spec.ts`, `AudiobookExportModal`, `BatchAudiobookSidebar`, `MultiVoiceCharacterModal`, `DocumentList` | Pass |
| Chapter error logs, diagnostics modal & failure pipeline | `tests/unit/audiobook-chapter-review.vitest.spec.ts`, `ChapterErrorLogModal`, `failure-log` route | Pass |
| Full repository unit suite | `pnpm exec vitest run --testTimeout=15000` | 180 files, 1,363 tests passed |

Additional release gates passed on `main`:

- `pnpm tsc --noEmit` (clean, 0 errors)
- `git diff --check` (clean, no whitespace violations)

Live Google Cloud synthesis, real credentials, browser interaction, and
production storage are not covered by the automated suite. Run those checks in
the Listenary staging deployment before promoting the feature.

The Director accepts the expanded acting vocabulary from the original plan,
enforces limits on secondary emotions, delivery styles, and tags, and rejects
new audio omissions after source cleanup. Director repairs, Cloud TTS splits,
transient retries, prompt compaction, and simplified or neutral fallbacks are
retained as listening-review flags. A successful diagnostic flag does not stop a
job configured to stop on failed synthesis. The Director receives prior scene
context for subsequent batches and receives the existing cleanup continuity
state during queued generation.

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

### Audiobook generation UI triggers

The `drama-gemini-tts` pipeline is integrated across all audiobook generation touchpoints:
- **AudiobookExportModal**: Automatically switches to Google Cloud Drama mode when a Cloud Drama
  profile is selected, auto-populates narrator voices from the profile, displays the primary button
  as `Generate Google Cloud Drama Audiobook`, and removes Kokoro voice prerequisites.
- **BatchAudiobookSidebar**: Displays the Google Cloud Gemini-TTS provider card, exposes Cloud Drama
  status cards with narrator details, and allows queuing without Kokoro voice dependencies.
- **MultiVoiceCharacterModal**: Features a `✨ Save & Generate Google Drama` button in standalone cast
  configuration, allowing immediate queuing of the audiobook upon saving the cast.
- **DocumentList**: Handles `AUDIOBOOK_REPLACEMENT_REQUIRED` confirmations and automatically starts
  the drama generation job after cast completion.

### Chapter failure diagnostics and error inspection

When a chapter fails validation (such as `DramaDirectorValidationError` caused by secondary emotion limits or text drift) or TTS synthesis:
- **Failure Artifact Retention**: Detailed validator issues are persisted directly into `${prefix}__pronunciation_failure.json` and mirrored into `documentSettings.smartAudioReviewFlags`.
- **Diagnostic Endpoint**: `GET /api/audiobook/failure-log?bookId=...(&chapterIndex=...)` extracts the structured error logs, background job messages, and segment flags.
- **ChapterErrorLogModal**: Surfaces line-by-line validation errors in a dark monospace log view, categorized with diagnostic badges (🎭 Drama Director Validation, 🛑 Safety Filter Block, ⏱️ Rate Limit, 🔊 FFmpeg / Audio Synthesis) and actionable recommendations.
- **Queue and Review Triggers**:
  - In `JobsInlineView`: Failed jobs expose a `📋 View Error Log & Diagnostics` button and an action bar `📋 Error Log` button.
  - In `/listen/[bookId]`: Failed chapters display an inline `📋 Log` button on list items, a `📋 View Error Log` button in the Chunk Actions toolbar, and a `📋 View All Error Logs` button in the review flags banner.
  - One-click `📋 Copy Diagnostic Log` copies the complete structured diagnostic payload for debugging or agent handoff.

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

## Gemini 3.8 migration status (2026-09-29)

Drama TTS now uses the Gemini Interactions API with `gemini-3.8-flash-tts`,
`x-goog-api-key` authentication, structured `speech_metadata.style`, approved
angle-bracket point events, and unary 24 kHz WAV output. The chapter pipeline
concatenates WAV chunks and encodes the final chapter MP3 once with ffmpeg.

The only automatic model fallback is `gemini-3.8-flash-lite-tts`. Legacy 3.7,
3.6, and Cloud Text-to-Speech request shapes are not accepted by the new path.
A Drama profile requires a Gemini API key; stored Cloud service-account data is
preserved only for legacy compatibility and is not required for Gemini 3.8.

### Remaining live gate

Before release, use a staging Gemini API key to run the plain narration,
emotion, whisper-style, inline-event, fallback, and short multi-segment chapter
smoke tests described in the migration plan. Verify that unary audio starts with
`RIFF`, tags are not spoken literally, and the final MP3/M4B plays correctly.
No live credential or staging execution was used for this code-only migration.


### Troubleshooting bundle

The audiobook export view and error modal offer **Download troubleshooting bundle (JSON)**,
including successful speaker snapshots, retained Director failures, cleanup/rejected text,
provider diagnostics, recent job metadata and review flags. Each artifact includes a SHA-256
checksum of its original stored bytes. The outer download remains valid JSON even when a
nested Director response contains invalid JSON; original response strings are preserved.

New Gemini Drama generation records every TTS HTTP attempt, including model, voice,
transcript, style, timing, audio byte count, provider usage when returned, and structured
quota/retry details. Separate chapter run IDs prevent retries from overwriting previous
attempt logs. Credentials and binary audio are excluded. Downloading never calls Gemini.

Capture is prospective: old successful TTS calls cannot be reconstructed. Successful
Director output is included as validated speaker assignments rather than raw provider
envelopes. The bundle is a live snapshot; compare job IDs and timestamps when examining
historical failures. Save it before deleting the book. Artifacts exceeding 8 MiB or the
32 MiB cumulative bundle input limit are listed as unavailable. Each attempt log retains
up to 2,000 requests and explicitly reports truncation.

## Director source-span reliability (2026-10-06)

Next-release note: Drama Director now returns schema-constrained direction over
immutable source IDs. Narratum reconstructs the exact cleaned source, preventing
model text drift and silent omissions; adaptive batches and bounded repairs reduce
large-output failures, and provider finish/token/coverage diagnostics aid recovery.

The chapter is split once into deterministic `s000001`-style spans at paragraph,
sentence and straight/double-smart quote boundaries, with a 600-byte soft target
at token boundaries. Pronunciation markup is atomic. No whitespace, Unicode,
punctuation or line wrapping is normalized. Span concatenation must equal the
cleaned authoritative source before any Director call. Groups must cover every ID
exactly once in order; only then does the server reconstruct the existing
`DramaDirectorSegment.text`. The legacy validator now requires exact equality too.

Batches have hard budgets of 12,000 source bytes and 48 spans, with paragraph or
sentence boundary preference in the latter half. The span count budgets worst-case
metadata output (~300 tokens per span), rather than assuming that source bytes
predict speaker density. Output is limited to 24,000 tokens. Single atomic source
units exceeding the byte budget fail before a provider call rather than splitting
pronunciation markup. These are conservative engineering budgets, not measured
provider guarantees; tune from the new diagnostics and staging observations.

The current Gemini 3.8 `generateContent` REST contract is configured using
`generationConfig.responseFormat.text = { mimeType: 'APPLICATION_JSON', schema }`.
All cast/span IDs and performance enums derive from authoritative shared values;
object shape and array limits are schema-constrained. Google's documented subset
does not support boolean `const`/`enum`, so `omit_from_audio` is a required boolean
with a false-only instruction and an authoritative server check. Server validation
also rejects unsupported tags and secondary emotions instead of silently filtering.

Contract references:
- https://ai.google.dev/gemini-api/docs/generate-content/structured-output
- https://ai.google.dev/api/generate-content#TextResponseFormat

Each failed batch has at most two corrections. Each correction contains one
original span prompt plus at most 20 issues / 4,000 issue characters; prior JSON
and prior repair prompts are never appended. Continuity text is bounded to 1,000
characters. Malformed JSON is never heuristically repaired. Non-STOP finish
reasons also fail even if the result parses. Exhausted attempts retain bounded
raw responses and finish/token/batch/parse/coverage metadata in the existing
Director failure artifact; normal structured logs contain no source or credentials.

Failure-log exports label their semantics as retained diagnostics, independent of
latest job status. The UI explains historical records and suppresses a current
failure banner for a completed job without removing useful history. TTS primary,
backup-key, Flash-Lite fallback and review/failed-segment behavior are unchanged.

No database or persisted segment migration is needed. Worker processes must load
the new code. A staging narration/dialogue/PDF-markup Director smoke remains a
live release gate; automated mock transport tests do not establish provider latency,
acting quality, quota availability or exact deployed-model schema support.

Verification for this update: 118 tests across 10 focused Director/orchestration/
request/synthesis/diagnostic/failover suites passed; full `pnpm test:unit` passed
199 files / 1,613 tests. `pnpm exec tsc --noEmit`, ESLint on the seven core/schema/
helper/test files, and `git diff --check` passed. The affected failure-log route
and diagnostic modal retain respectively 1 and 23 existing ESLint errors; a
read-only HEAD comparison confirmed no increase. No live Gemini or browser smoke
was run. Existing unrelated local changes were preserved.

### 2026-10-08 — Director structured-output MIME enum correction

The production chapter artifact showed three identical pre-generation HTTP 400
rejections. `responseFormat.text.mimeType` requires `APPLICATION_JSON`, not the
`application/json` string accepted by legacy `responseMimeType`. Corrected the
request while preserving its structured schema, immutable source spans, server
validation and TTS failover. Contract reference:
https://ai.google.dev/api/generate-content#v1beta.TextResponseFormat

A regression transport rejects the production value and accepts the correct enum,
then verifies exact server-owned source reconstruction. Verification: eight
focused suites / 89 tests and all 206 unit files / 1,745 tests passed; TypeScript
and affected-file ESLint passed. No live provider request was made. Deploy/restart
workers before retrying affected chapters; retained failure history is preserved.
