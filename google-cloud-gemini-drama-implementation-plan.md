# OpenReader — Drama (Gemini 3.1 Flash TTS via Google Cloud)

> **Plan superseded for Stages 11–12:** Use the revised Narratum requirements supplied by the maintainer on 2026-09-22. The revised Stage 11 covers Google Cloud Drama profile performance settings, deterministic Drama Director policy mapping, language, failure behavior, credential status, and connection testing. The revised Stage 12 covers persistent cast direction plus Voice Only, Character Performance, and Scene Preview modes. Preserve the internal worker identifier `drama-gemini-tts`; do not rename persisted identifiers during the Narratum product rename.

## Staged Implementation Plan for Coding Agents

- **Project:** https://github.com/fajis1/openreader
- **Plan status:** READY FOR STAGED IMPLEMENTATION
- **Target TTS model:** `gemini-3.1-flash-tts-preview`
- **Target API:** Google Cloud Text-to-Speech API
- **New Smart Audio worker mode:** `drama-gemini-tts`
- **Plan date:** 2026-09-18

---

## 0. How Agents Must Use This Plan

This document is intentionally divided into stages.

**Agents must work one stage at a time.**

### Mandatory stage rule

An agent must **NOT** begin the next stage merely because the current stage appears complete.

At the end of every stage the agent must:
1. Run the required tests/checks for that stage.
2. Review the diff for accidental unrelated changes.
3. Update the Stage Progress Ledger in this document if the repository workflow allows it.
4. Produce the Stage Completion Report defined below.
5. **STOP and wait for the user/maintainer to authorize the next stage.**

This is important because several stages change shared Smart Audio infrastructure used by the existing Kokoro Drama mode. The existing mode must remain functional throughout the implementation.

### Required Stage Completion Report

At the end of every stage, the agent must output:

```
STAGE COMPLETE: Stage <number> — <name>

Status:
- COMPLETE / BLOCKED / COMPLETE WITH NOTES

Files changed:
- path/to/file
- path/to/file

What was implemented:
- ...
- ...

Tests/checks run:
- <command> — PASS/FAIL
- <command> — PASS/FAIL

Manual verification:
- ...

Backward compatibility:
- Existing Kokoro Drama affected? YES/NO
- Existing Standard/Scholar modes affected? YES/NO
- If YES, explain exactly why.

Known issues / follow-up:
- ...

Deviations from this plan:
- None
OR
- <explain exactly what changed and why>

Commit:
- <commit hash if committed>

Ready for next stage:
- YES/NO
```

**STOP. Do not begin the next stage until instructed.**

If a stage is blocked, the agent must state the exact blocker and stop instead of making a speculative architectural change.

---

## 1. Stage Progress Ledger

*Update only after a stage passes its acceptance criteria.*

| Stage | Name | Status | Commit / Notes |
|---|---|---|---|
| 0 | Baseline and architecture lock | ✅ Complete | Tracking baseline in `docs/google-cloud-drama-baseline.md` |
| 1 | Provider-aware Drama foundations | ✅ Complete | `DRAMA_GEMINI_TTS_WORKER_MODE`, parameterized `getCharacterMapReadiness` & `autoAssignMinorCharacterVoices` |
| 2 | Google Cloud credential model | ✅ Complete | SA JSON field, redaction, merge, `google-cloud-auth.ts` token minting |
| 3 | Cloud Gemini-TTS client spike | ✅ Complete | `google-cloud-tts-client.ts`: byte constants, tag allowlist, `TokenCache`, `synthesizeWithCloudTts` |
| 4 | Voice catalog and cast assignment | ✅ Complete | `google-cloud-tts-voices.ts`, provider-aware normalizer, `google-cloud-cast-helpers.ts` |
| 5 | Character direction data model | ✅ Complete | `DramaCharacterDirection` on cast entries; normalized persistence and rescan preservation |
| 6 | Performance vocabulary and Director schema | ✅ Complete | Shared controlled vocabularies, typed segment, canonical Cloud TTS tag allowlist |
| 7 | Gemini Drama Director prompt and validation | ✅ Complete | 11 author prompt examples, 4 held-out fixtures, strict output validation, one repair attempt, Gemini JSON transport |
| 8 | Director's Brief and Cloud TTS request builder | ✅ Complete | Cast-resolved brief and REST body; corrected `input.prompt` and `voice.modelName` |
| 9 | Safe chunking, tag handling, retries, review flags | ✅ Complete | UTF-8 source partition, categorized tags, bounded transient retries, explicit failed chunks and review flags |
| 10 | End-to-end drama-gemini-tts orchestration | ✅ Complete with notes | Queue/chapter branching, Director and Cloud synthesis, MP3 stitching, silence placeholders, persisted review flags; live Cloud smoke remains |
| 11 | Google Cloud Drama profile, performance settings, and credential UI | ✅ Complete with notes | Revised Narratum Stage 11 implemented: normalized performance policy, language/failure controls, write-only credential status, explicit removal, and sanitized synthesis-path connection test; automated/manual-environment checks pass; live Google Cloud credential verification remains user-required |
| 12 | Cast direction UI and performance-aware voice previews | ✅ Complete with notes | Revised Narratum Stage 12 implemented: persistent direction/voice editing, rescan preservation, Voice Only/Character Performance/Scene Preview through shared Cloud request infrastructure; automated checks pass; listening/browser verification remains user-required |
| 13 | Review/recovery UI | ⬜ Not started | |
| 14 | Test matrix, documentation, migration, release readiness | ⬜ Not started | |

*Legend: ⬜ Not started · 🟨 In progress · ✅ Complete · ⛔ Blocked*

---

## 2. Goal

Create a new Smart Audio profile for dramatic audiobooks that builds on OpenReader's existing Drama character/cast understanding but uses Google Cloud Gemini-TTS to produce significantly more expressive character performances.

The desired conceptual pipeline is:

```
Existing OpenReader source cleanup / Drama understanding
                        ↓
Authoritative cleaned chapter text
                        ↓
Gemini Drama Director
- speaker assignment
- scene context
- performance intent
- NO rewriting of the spoken text
                        ↓
Strict OpenReader validator
- cast membership
- exact text preservation
- controlled vocabulary
- safe audio-tag allowlist
                        ↓
OpenReader resolves character → voice
                        ↓
Director's Brief builder
- stable character identity
- scene
- emotion
- delivery
- pace
- energy
- intensity
- social intent
                        ↓
Safe transcript annotation
- only verified localized markup tags
                        ↓
Google Cloud Text-to-Speech API
`gemini-3.1-flash-tts-preview`
                        ↓
Audio per performance segment
                        ↓
Stitching
                        ↓
Review flags for anything that required fallback/manual attention
```

---

## 3. Non-Goals for the Initial Implementation

Do NOT expand the project unnecessarily during the MVP.

The first implementation will NOT:
- Replace the existing Kokoro Drama mode.
- Change Scholar mode to Google Cloud TTS.
- Use Google Cloud TTS for Biblical Scholar pronunciation.
- Attempt whole-cast multi-speaker synthesis.
- Allow Gemini to freely invent arbitrary inline audio tags.
- Allow Gemini to choose a character's voice on every segment.
- Silently drop a sentence when synthesis fails.
- Depend on Replicate's Gemini TTS implementation.
- Reuse the current Speech SDK Google model as the Cloud implementation.
- Add voice cloning.
- Add sound effects/music generation.
- Add automatic accents based on ethnicity or nationality.
- Automatically infer sensitive real-world attributes from character descriptions.
- Require the new mode for users who prefer the existing Drama/Kokoro workflow.

*Two-speaker Cloud synthesis may be considered later, after the single-speaker-per-performance-segment path is stable.*

---

## 4. Verified Source-of-Truth Constraints

Agents must treat the following as implementation constraints unless current official Google documentation has changed at implementation time.

### 4.1 OpenReader current architecture

At plan creation time:
- `MULTI_VOICE_WORKER_MODE` is the existing Drama/Kokoro worker mode.
- `getCharacterMapReadiness()` validates voices against the Kokoro voice set.
- `autoAssignMinorCharacterVoices()` is Kokoro-specific.
- The chapter route rejects the existing Drama mode when the selected model is not Kokoro.
- `google/gemini-3.1-flash-tts` exists under the Replicate provider.
- The Speech SDK provider currently lists `google/gemini-2.5-flash-preview-tts`.
- `GEMINI_FLASH_TTS_VOICES` already contains the Gemini voice names that can be reused as the base Cloud voice catalog.

Relevant repository files include:
- `src/lib/shared/multi-voice.ts`
- `src/lib/shared/tts-provider-catalog.ts`
- `src/app/api/audiobook/chapter/route.ts`
- `src/types/document-settings.ts`
- `src/lib/server/smart-audio-profiles.ts`
- `src/components/AudiobookExportModal.tsx`
- `src/components/SmartAudioSettings.tsx`

*Agents must inspect the current branch before editing because line numbers and surrounding implementations may have changed.*

### 4.2 Google Cloud Gemini-TTS limits

For Cloud Text-to-Speech Gemini-TTS:
- `input.text` maximum: 4,000 bytes.
- `input.prompt` maximum: 4,000 bytes.
- Combined prompt + text maximum: 8,000 bytes.
- Measure UTF-8 bytes, not JavaScript character count.
- Output audio can be truncated if it grows to roughly 655 seconds.
- `gemini-3.1-flash-tts-preview` supports MP3 for unary synthesis.
- The Cloud TTS REST endpoint is:
  `https://texttospeech.googleapis.com/v1/text:synthesize`

The initial implementation should use conservative internal limits:
```typescript
export const CLOUD_TTS_MAX_FIELD_BYTES = 4000;
export const CLOUD_TTS_SAFE_TEXT_BYTES = 3600;
export const CLOUD_TTS_SAFE_PROMPT_BYTES = 3600;
```
The final request builder MUST still measure the finished values immediately before transmission.

### 4.3 Authentication

- Do not use a simple Google API key as the authentication design for Gemini-TTS.
- The authenticated principal must be capable of Cloud TTS access and Gemini-TTS requires the `aiplatform.endpoints.predict` permission.
- The initial OpenReader design will support:
  1. Per-profile Service Account JSON — primary self-hosted/user-managed option.
  2. Application Default Credentials (ADC) — optional server-managed/deployment option.
- Do not send service-account JSON to the browser after it is stored.
- Do not claim that credentials are encrypted at rest unless the existing storage layer actually provides encryption at rest.

### 4.4 Prompting model

Use Google's three control levers deliberately:
- **Style Prompt** — overall acting direction.
- **Text Content** — exact spoken text.
- **Markup Tags** — localized actions/modifiers only.

Emotion such as fear, love, passion, excitement, grief, determination, or anger belongs primarily in the Style Prompt, not arbitrary bracket tags.

### 4.5 Markup tags

The initial production allowlist is intentionally smaller than the performance vocabulary.

High-reliability starting tags:
```typescript
export const DRAMA_ONE_SHOT_TAGS = [
  'sigh',
  'laughing',
  'uhm',
] as const;

export const DRAMA_STYLE_TAGS = [
  'sarcasm',
  'robotic',
  'shouting',
  'whispering',
  'extremely fast',
] as const;

export const DRAMA_PAUSE_TAGS = [
  'short pause',
  'medium pause',
  'long pause',
] as const;
```

Emotional adjective tags such as `[scared]`, `[curious]`, and `[bored]` are NOT part of the initial production allowlist because Google's current documentation warns that this class of tag may be vocalized.

New tags may be added only after explicit listening tests.

---

## 5. Core Design Principles

These principles apply to every stage.

### 5.1 The spoken text is authoritative

The Drama Director is allowed to:
- partition text into speaking segments,
- assign speakers,
- describe scene context,
- choose controlled performance attributes,
- choose safe localized tags.

The Drama Director is **NOT** allowed to:
- paraphrase,
- summarize,
- rewrite dialogue,
- improve prose,
- delete narration,
- add dialogue,
- change punctuation solely for creative effect unless an existing cleanup step already authorizes it.

Every narratable source sentence must remain represented.

### 5.2 Casting is persistent

A character's `voiceId` lives in the cast map. The Director output must NOT include `voiceId`.

```json
// Correct:
{
  "speaker": "Rina",
  "text": "Get away from him!",
  "performance": {
    "primaryEmotion": "terrified",
    "secondaryEmotions": ["angry"],
    "socialIntent": "protective",
    "delivery": ["forceful"],
    "pace": "fast",
    "energy": "high",
    "intensity": "building",
    "tags": ["shouting"]
  }
}

// Incorrect:
{
  "speaker": "Rina",
  "voiceId": "Kore"
}
```

OpenReader resolves the voice:
```typescript
const character = characterMap.entries[segment.speaker];
const voiceId = character.voiceId;
```
This prevents voice drift across chapters.

### 5.3 Character identity and moment acting are separate

- **LEVEL 1 — Character Direction**: Stored in the cast entry. Stable across the audiobook.
- **LEVEL 2 — Moment Direction**: Generated per segment by the Drama Director. Changes with the story.

### 5.4 Prefer structured choices over free invention

The Director should choose from rich controlled vocabularies for primary emotion, secondary emotions, social intent, delivery style, pace, energy, and intensity.

Freeform text can still be generated for short scene context, optional performance note, and limited nuance.

### 5.5 Failure must be visible

Do not silently omit text. When a line cannot be synthesized after retries:
- preserve the text,
- preserve the character,
- add a review flag,
- keep the audiobook job moving,
- use a short placeholder/silence segment if the stitching pipeline requires an audio object,
- allow later manual retry/regeneration.

---

## 6. Stages Breakdown

### STAGE 0 — Baseline and Architecture Lock
- Establish a clean baseline before touching shared Drama code.
- Record commit hash, test status, code paths for Kokoro guards, profile secrets, audio stitching, and speaker assignment.
- Deliverable: `docs/google-cloud-drama-baseline.md`.
- Stop gate: Stage 0 Completion Report.

### STAGE 1 — Provider-Aware Drama Foundations
- Add `DRAMA_GEMINI_TTS_WORKER_MODE = 'drama-gemini-tts'`.
- Parameterize `getCharacterMapReadiness` and `autoAssignMinorCharacterVoices`.
- Stop gate: Stage 1 Completion Report.

### STAGE 2 — Google Cloud Credential Model
- Add service account JSON and ADC support.
- Safe redaction and server-side secret persistence.
- Stop gate: Stage 2 Completion Report.

### STAGE 3 — Cloud Gemini-TTS Client Spike
- Smallest vertical slice synthesizing 1 sentence to MP3 via Google Cloud REST endpoint.
- Stop gate: Stage 3 Completion Report.

### STAGE 4 — Gemini Cloud Voice Catalog and Cast Assignment
- Verified female/male catalogs, auto-assignment, narrator and main character protections.
- Stop gate: Stage 4 Completion Report.

### STAGE 5 — Character Direction Data Model
- `DramaCharacterDirection` (`audioProfile`, `defaultPerformance`, technical overrides) on `SmartAudioCharacterEntry`.
- Stop gate: Stage 5 Completion Report.

### STAGE 6 — Performance Vocabulary and Drama Director Schema
- Typed controlled vocabularies in `src/lib/shared/drama-director-schema.ts`:
  - `DRAMA_UTTERANCE_TYPES = ['narration', 'spoken-dialogue', 'internal-thought', 'squad-link'] as const`
  - `DRAMA_SOCIAL_INTENTS`: include `'teasing', 'bantering', 'celebrating', 'complaining'` along with baseline social intents.
  - `DRAMA_PRIMARY_EMOTIONS`, `DRAMA_SECONDARY_EMOTIONS`, `DRAMA_DELIVERY_STYLES`, `DRAMA_PACING`, `DRAMA_ENERGY`, `DRAMA_INTENSITY`.
  - `DRAMA_AUDIO_TAG_ALLOWLIST`, `ONE_SHOT_TAGS`, `STYLE_TAGS`, `PAUSE_TAGS`.
- `DramaDirectorSegment` schema:
  - `speaker`: string (must match cast entry)
  - `utteranceType`: DramaUtteranceType
  - `text`: string (exact verbatim text)
  - `sceneContext`: string (1-3 sentences)
  - `performance`: { primaryEmotion, secondaryEmotions, socialIntent, delivery, pace, energy, intensity, tags, nuance? }
  - `omit_from_audio`: boolean
- Stop gate: Stage 6 Completion Report.

### STAGE 7 — Gemini Drama Director Prompt and Validation
- Director prompt + validation + repair loop ensuring exact text preservation.
- Grounding via `docs/drama-director-few-shot-library.md`:
  - Embed 11 author few-shot examples into the Director prompt (teaching narrative context vs formatting, natural squad-link delivery, quiet intensity, tag restraint).
  - Retain 4 held-out examples as unit test evaluation fixtures.
- Strict validator ensuring:
  1. Cast membership (`speaker` in cast)
  2. Utterance type validity (`utteranceType` in `DRAMA_UTTERANCE_TYPES`)
  3. Controlled vocabulary adherence
  4. Tag allowlist stripping
  5. Exact text preservation (concatenated segment text matches source chapter text without additions, omissions, or paraphrasing)
- Stop gate: Stage 7 Completion Report.

### STAGE 8 — Director's Brief and Cloud TTS Request Builder
- Build Director's Brief + annotated text into exact Google Cloud request.
- Stop gate: Stage 8 Completion Report.

### STAGE 9 — Safe Chunking, Tag Handling, Retries, and Review Flags
- UTF-8 byte-safe splitting, one-shot vs style tags, retries, and review flags.
- Stop gate: Stage 9 Completion Report.

### STAGE 10 — End-to-End drama-gemini-tts Orchestration
- Wire mode into chapter route, worker, and stitching pipeline.
- Stop gate: Stage 10 Completion Report.

### STAGE 11 — Smart Audio Profile and Credential UI
- Add Drama mode card and GCP credential configuration in Smart Audio Settings.
- Stop gate: Stage 11 Completion Report.

### STAGE 12 — Cast Direction UI and Voice Previews
- Cast card character direction expandable inputs and voice previews.
- Stop gate: Stage 12 Completion Report.

### STAGE 13 — Review and Recovery UI
- Listening page review flags panel and retry recovery.
- Stop gate: Stage 13 Completion Report.

### STAGE 14 — Test Matrix, Documentation, Migration, and Release Readiness
- Regression test matrix, documentation, and release gate verification.
- Stop gate: Stage 14 Completion Report.
