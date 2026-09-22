# Google Cloud Drama Baseline & Architecture Lock (Stage 0)

- **Date:** 2026-09-18
- **Branch:** `main`
- **Baseline Commit:** `bf8325d9ee200ed35a56051f6dc1321dae9260bd`
- **Feature Target:** `drama-gemini-tts` (Google Cloud Text-to-Speech `gemini-3.1-flash-tts-preview`)

---

## 1. Baseline Build & Test Status

- **TypeScript Compilation (`pnpm tsc --noEmit`):** ✅ Clean (0 errors)
- **Unit Test Suite (`pnpm vitest run`):** ✅ Clean (162/162 test files passed, 1,115/1,115 tests passed)
- **Working Tree State:** Clean baseline + previous uncommitted task changes (Pronunciation fallback model configuration & pre-scan UI interactive selector) verified with all tests passing.

---

## 2. Hardcoded Kokoro & Drama Code Paths

### 2.1 `MULTI_VOICE_WORKER_MODE`
- **Definition:** `src/lib/shared/multi-voice.ts:12` (`export const MULTI_VOICE_WORKER_MODE = 'multi-voice' as const;`)
- **Guards & Usages:**
  - `src/app/api/audiobook/chapter/route.ts`:
    - Line 599: Mode guard checking `workerMode === MULTI_VOICE_WORKER_MODE`
    - Line 600: Rejection `if (!isKokoroModel(model))` returning `MULTI_VOICE_KOKORO_REQUIRED`
    - Lines 848, 877, 887, 919: Dispatching multi-voice payload and subject to worker
  - `src/app/api/audiobook/characters/scan/route.ts`:
    - Line 65: Guard `if (profile.workerMode !== MULTI_VOICE_WORKER_MODE)`
  - `src/app/api/audiobooks/queue/route.ts`:
    - Line 128: Preflight checks for multi-voice readiness
  - `src/lib/server/audiobooks/worker.ts`:
    - Line 1083, 1133, 1231, 1272, 1369: Multi-voice worker loop and segment normalization
  - `src/components/AudiobookExportModal.tsx`:
    - Line 130: UI conditional rendering for character cast review
  - `src/components/doclist/BatchAudiobookSidebar.tsx`:
    - Line 140: Batch sidebar cast check
  - `src/lib/server/audiobooks/smart-audio-timeout.ts`:
    - Line 13: Timeout calculation for multi-voice jobs

### 2.2 `KOKORO_CHARACTER_VOICE_SET` & `KOKORO_RECYCLABLE_ENGLISH_VOICES`
- **Definitions:** `src/lib/shared/multi-voice.ts`:
  - Line 17: `const KOKORO_CHARACTER_VOICE_SET = new Set<string>(KOKORO_CHARACTER_VOICES);`
  - Line 447: `export const KOKORO_RECYCLABLE_ENGLISH_VOICES = [...]`
- **Guards & Usages:**
  - Line 66: `characterEntry()` voice validation
  - Line 191: `getCharacterMapReadiness()` filters `!entry.voiceId || !KOKORO_CHARACTER_VOICE_SET.has(entry.voiceId)`
  - Line 410: Voice tag parser checks against Kokoro set
  - Lines 528, 533: `autoAssignMinorCharacterVoices()` hardcodes `KOKORO_RECYCLABLE_ENGLISH_VOICES`
  - Line 560: `autoAssignMinorCharacterVoices()` skips already assigned Kokoro voices

### 2.3 `getCharacterMapReadiness`
- **Definition:** `src/lib/shared/multi-voice.ts:181`
- **Call Sites:**
  - `src/app/api/audiobook/chapter/route.ts:618` (rejects unassigned casts with `CHARACTER_CAST_REQUIRED`)
  - `src/app/api/audiobook/characters/scan/route.ts:127`
  - `src/app/api/audiobooks/queue/route.ts:146`
  - `src/lib/server/audiobooks/worker.ts:410, 437, 1084, 1111`
  - `src/lib/shared/multi-voice.ts:209, 609`

### 2.4 `autoAssignMinorCharacterVoices`
- **Definition:** `src/lib/shared/multi-voice.ts:472`
- **Call Sites:**
  - `src/lib/server/audiobooks/worker.ts:418, 1087, 1447`

---

## 3. Data Models & Schemas

### 3.1 Smart Audio Character Entry & Review Flags
- **`SmartAudioCharacterEntry`:**
  - `src/types/document-settings.ts:26`:
    ```typescript
    export interface SmartAudioCharacterEntry {
      name: string;
      description: string;
      sampleText: string;
      voiceId?: string | null;
      aliasFor?: string | null;
      // To be extended in Stage 5 with optional dramaCharacterDirection?: DramaCharacterDirection;
    }
    ```
- **`SmartAudioReviewFlag`:**
  - `src/types/document-settings.ts:44`:
    ```typescript
    export interface SmartAudioReviewFlag {
      id: string;
      chapterIndex: number;
      timestampMs: number;
      createdAt: number;
      resolvedAt?: number | null;
      // To be extended in Stage 9 with type, segmentIndex, speaker, message, sourceText, details
    }
    ```
  - Normalization: `src/lib/shared/document-settings.ts:72` (`normalizeSmartAudioReviewFlags`)
  - Route: `src/app/api/audiobook/review-flags/route.ts`

### 3.2 Smart Audio Profile Types (Client & Server)
- **Client Interface:** `src/types/client.ts:82` (`SmartAudioProfile`)
- **Model Resolvers:** `src/lib/shared/smart-audio-models.ts` (`SmartAudioModelProfile`, `resolveCleanupAiModels`, `resolvePronunciationAiModels`)
- **Server Persistence & Sanitization:** `src/lib/server/smart-audio-profiles.ts`
  - `readSmartAudioProfilesDocument(userId: string)`
  - `saveSmartAudioProfilesDocument(userId: string, document: SmartAudioProfilesDocument)`
  - `sanitizeProfile(profile)`
  - `redactSmartAudioProfileSecrets(profile)`

---

## 4. Secret Persistence & Redaction Path

- **Database Storage:** Stored in `userPreferences` table in DB with key `smart_audio_profiles` (JSON blob containing `profiles[]`).
- **Server Flow:**
  - When saved via `POST /api/tts-settings`, `saveSmartAudioProfilesDocument` preserves existing stored secrets if incoming secret string is empty/omitted.
  - When read via `GET /api/tts-settings` or exported, `redactSmartAudioProfileSecrets` strips raw keys and replaces them with boolean configured flags (`geminiApiKeyConfigured`, `backupGeminiApiKeyConfigured`, `groqApiKeyConfigured`) and masked last 4 characters.
  - For Google Cloud service accounts (Stage 2), raw JSON will never be returned to the client and will only expose non-secret metadata (e.g. `client_email`).

---

## 5. Audio Stitching & Synthesis Architecture

- **Buffer Concatenation:** `src/lib/server/audiobooks/segmented-tts.ts:25` (`concatenateMp3Segments`).
  - Writes segments to temp directory (`openreader-tts-segments-XXXXXX`).
  - Invokes `ffmpeg -f concat -safe 0 -i segments.txt -c:a libmp3lame -b:a 64k combined.mp3`.
- **M4B / Single File Stitching:** `src/lib/server/audiobooks/combine.ts:184` (concatenates chapters into M4B with chapter markers).
- **TTS Generation Route:** `src/lib/server/tts/generate.ts` (`generateTTSBuffer`).

---

## 6. Current Drama Speaker Assignment Flow

1. Authoritative chapter text is extracted and cleaned.
2. In `src/lib/server/audiobooks/worker.ts:1369`, the Gemini prompt asks the LLM to return speaker segments matching the cast.
3. `normalizeMultiVoiceSegments` (`src/lib/shared/multi-voice.ts:317`):
   - Maps normalized speaker names against `cast.members` and aliases.
   - Enforces voice continuity from cast entry.
   - Currently merges consecutive lines from same speaker (`previous?.speaker === member.name`).
   - For `drama-gemini-tts`, this will be replaced by the Gemini Drama Director pass (no merging of consecutive lines with different performance intents).

---

## 7. Deviations & Observations for Subsequent Stages

1. `multi-voice.ts` has 628 lines. Parameterizing `getCharacterMapReadiness` with `options.validVoiceSet ?? KOKORO_CHARACTER_VOICE_SET` in Stage 1 is fully backward compatible and preserves Kokoro defaults.
2. The chapter route guard (`if (!isKokoroModel(model))`) must remain for `MULTI_VOICE_WORKER_MODE`, while `DRAMA_GEMINI_TTS_WORKER_MODE` will introduce its own separate preflight branch in Stage 10.
3. No pending repository conflicts detected.
