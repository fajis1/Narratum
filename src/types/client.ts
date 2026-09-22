import type {
  TTSAudiobookChapter,
  TTSAudiobookFormat,
  TTSSentenceAlignment,
} from '@/types/tts';
import type { TtsProviderType } from '@/lib/shared/tts-provider-catalog';

// --- TTS Client Request Types ---

// Headers used when calling TTS-related endpoints from the client.
export type TTSRequestHeaders = Record<string, string>;

// Options for retrying TTS requests on failure in withRetry
export interface TTSRetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
  pingOperation?: () => Promise<boolean>;
  postPingDelay?: number;
}

export interface TTSRequestError extends Error {
  status?: number;
  code?: string;
  type?: string;
  title?: string;
  detail?: string;
}

// --- Audiobook API Types ---

export interface AudiobookStatusResponse {
  exists: boolean;
  chapters: TTSAudiobookChapter[];
  bookId: string | null;
  hasComplete: boolean;
  settings?: AudiobookGenerationSettings | null;
}

export interface AudiobookGenerationSettings {
  providerRef: string;
  providerType: TtsProviderType;
  ttsModel: string;
  voice: string;
  nativeSpeed: number;
  postSpeed: number;
  format: TTSAudiobookFormat;
  ttsInstructions?: string;
  language?: string;
  smartAudioProfileId?: string;
  useSmartAudio?: boolean;
  /** Internal queue acknowledgement that an unresolved Scholar lexicon may be auto-scanned. */
  scholarAutoScan?: boolean;
  /**
   * Scholar / bibliography-catcher only. When true, the cached English contextual definitions
   * are injected inline next to foreign terms before the Gemini cleanup pass.
   * Defaults to true when absent (preserves existing Scholar behavior).
   */
  scholarIncludeDefinitions?: boolean;
  /** Internal chapter-map version. Missing/1 retains legacy 4K resume boundaries; 2 uses 12K cleanup batches. */
  cleanupBatchVersion?: number;
}

export interface CreateChapterPayload {
  chapterTitle: string;
  text: string;
  bookId: string;
  /** Source document whose pronunciation/definition lexicon should be used. */
  documentId?: string;
  format: TTSAudiobookFormat;
  chapterIndex: number;
  settings?: AudiobookGenerationSettings;
}

/** Identifies an LLM provider slot in the scan provider order. */
export type ScanProvider = 'gemini_primary' | 'gemini_backup' | 'groq';

/** Default provider order when none is configured. */
export const DEFAULT_PROVIDER_ORDER: ScanProvider[] = ['gemini_primary', 'gemini_backup', 'groq'];

export interface SmartAudioProfile {
  id: string;
  name: string;
  /** Gemini model used for high-volume text cleanup. */
  aiModel: string;
  /** Optional ordered Gemini cleanup fallbacks used before pausing for quota. */
  aiModelFallbacks?: string[];
  /** Gemini model used only for pronunciation scanning and refinement. */
  pronunciationAiModel?: string;
  /** Optional ordered Gemini pronunciation fallbacks used before failing. */
  pronunciationAiModelFallbacks?: string[];
  customTtsPrompt: string;
  abbreviations: Record<string, string>;
  pronunciations: Record<string, string>;
  books: Record<string, string>;
  /** Whether to merge in the globally defined pronunciations. */
  useGlobalPronunciations?: boolean;
  /** Whether this profile inherits the universal pronunciation guidance or supplies its own style guidance. */
  pronunciationPromptMode?: 'default' | 'custom';
  /** Profile-specific pronunciation style guidance. The required Kokoro compatibility policy is always appended separately. */
  customPronunciationPrompt?: string;
  /** Per-profile Gemini API key. Never exposed to other users. */
  geminiApiKey?: string;
  backupGeminiApiKey?: string;
  /** Safe client metadata returned instead of the stored primary key. */
  geminiApiKeyConfigured?: boolean;
  geminiApiKeyLast4?: string;
  /** Safe client metadata returned instead of the stored backup key. */
  backupGeminiApiKeyConfigured?: boolean;
  backupGeminiApiKeyLast4?: string;
  /** Per-profile Groq API key used as a free-tier fallback after both Gemini keys are exhausted. Never exposed to other users. */
  groqApiKey?: string;
  /** Safe client metadata returned instead of the stored Groq key. */
  groqApiKeyConfigured?: boolean;
  groqApiKeyLast4?: string;
  /** Write-only request metadata for copying a stored key without exposing it. */
  geminiApiKeySourceProfileId?: string;
  backupGeminiApiKeySourceProfileId?: string;
  /**
   * Ordered list of LLM providers for the foreign-word scan.
   * The scan tries each in order, advancing to the next on any failure.
   * Omitted providers (no key configured) are automatically skipped.
   * Default when absent: ['gemini_primary', 'gemini_backup', 'groq']
   */
  providerOrder?: ScanProvider[];
  /**
   * Whether locally cached book definitions should be spoken during the
   * single Smart Audio cleanup pass.
   * 'standard' → pronunciation markup only
   * 'scholar'  → pronunciation markup plus the cached contextual definition
   * 'bibliography-catcher' → provides structural layout tags to Gemini for better end-matter pruning
   * 'multi-voice' → Kokoro Audio Drama (multi-character TTS)
   * 'drama-gemini-tts' → Google Cloud Gemini-TTS Audio Drama (expressive multi-character TTS)
   * Defaults to 'standard' when absent.
   */
  workerMode?: 'standard' | 'scholar' | 'bibliography-catcher' | 'multi-voice' | 'drama-gemini-tts';
  resolvedDictionaryHash?: string | null;

  // ── Google Cloud Service Account credentials (for drama-gemini-tts) ──────────
  /**
   * Write-only: raw Google Cloud Service Account JSON key.
   * Stored server-side only; NEVER returned to the client after saving.
   * The authenticated principal must have roles/aiplatform.user (aiplatform.endpoints.predict).
   */
  googleCloudServiceAccountJson?: string;
  /**
   * Safe client-side flag: true when a service account JSON is stored for this profile.
   * Replaces the raw JSON in all responses to the browser.
   */
  googleCloudServiceAccountConfigured?: boolean;
  /**
   * Safe client-side metadata: the client_email from the stored service account JSON,
   * shown in the UI so users can verify which account is active.
   * Null when no service account is configured.
   */
  googleCloudServiceAccountEmail?: string | null;
}


// --- TTS Voices API Types ---

export interface VoicesResponse {
  voices: string[];
}

export interface TTSSegmentSettings {
  providerRef: string;
  providerType: TtsProviderType;
  ttsModel: string;
  voice: string;
  nativeSpeed: number;
  ttsInstructions?: string;
  language?: string;
}

type TTSReaderType = 'pdf' | 'epub' | 'html';

/**
 * Locator describing where a TTS segment came from inside a document.
 *
 * Field usage by readerType:
 *  - PDF:  `page` (1-based).
 *  - HTML: `location` (free-form fragment id / scroll anchor).
 *  - EPUB: **stable book coordinates** — `spineHref`, `spineIndex`, `charOffset`.
 *          `cfi` is a best-effort jump hint only; it is NOT used for identity,
 *          grouping, sorting, or matching. The stable coordinates are the same
 *          across devices and window sizes.
 *
 * The interface is structurally permissive for backwards compatibility with
 * in-flight code paths, but the server-side `normalizeLocator` enforces the
 * required fields per readerType before persisting. Use the
 * `isStableEpubLocator` / `isPdfLocator` / `isHtmlLocator` guards at read sites
 * that need a particular shape.
 */
export interface TTSSegmentLocator {
  readerType?: TTSReaderType;
  // PDF / legacy
  page?: number;
  // PDF block-level locator (structured parser path)
  blockId?: string;
  // HTML / legacy EPUB CFI (kept for in-flight drafts; not persisted for EPUB)
  location?: string;
  // Stable EPUB coordinates
  spineHref?: string;
  spineIndex?: number;
  charOffset?: number;
  /** Best-effort jump hint for EPUB; not part of identity/sort/group. */
  cfi?: string;
}

export function isPdfLocator(
  locator: TTSSegmentLocator | null | undefined,
): locator is TTSSegmentLocator & { readerType: 'pdf'; page: number } {
  return !!locator
    && locator.readerType === 'pdf'
    && typeof locator.page === 'number'
    && Number.isFinite(locator.page);
}

export function isHtmlLocator(
  locator: TTSSegmentLocator | null | undefined,
): locator is TTSSegmentLocator & { readerType: 'html'; location: string } {
  return !!locator
    && locator.readerType === 'html'
    && typeof locator.location === 'string'
    && locator.location.length > 0;
}

/**
 * Narrow to a fully-stable EPUB locator. Returns false for EPUB drafts that
 * only carry a CFI — those must be resolved to spine coordinates before being
 * sent to the server.
 */
export function isStableEpubLocator(
  locator: TTSSegmentLocator | null | undefined,
): locator is TTSSegmentLocator & {
  readerType: 'epub';
  spineHref: string;
  spineIndex: number;
  charOffset: number;
} {
  return !!locator
    && locator.readerType === 'epub'
    && typeof locator.spineHref === 'string'
    && locator.spineHref.length > 0
    && typeof locator.spineIndex === 'number'
    && Number.isFinite(locator.spineIndex)
    && typeof locator.charOffset === 'number'
    && Number.isFinite(locator.charOffset);
}

export interface TTSSegmentInput {
  segmentIndex: number;
  segmentKey?: string;
  text: string;
  locator?: TTSSegmentLocator;
}

export interface TTSSegmentsEnsureRequest {
  documentId: string;
  segments: TTSSegmentInput[];
  settings: TTSSegmentSettings;
}

export interface TTSSegmentManifestItem {
  segmentId: string;
  segmentIndex: number;
  segmentKey?: string | null;
  audioPresignUrl: string | null;
  audioFallbackUrl: string | null;
  durationMs: number;
  alignment: TTSSentenceAlignment | null;
  locator: TTSSegmentLocator | null;
  status: 'pending' | 'completed' | 'error';
  error?: {
    code: string;
    detail?: string;
    upstreamStatus?: number;
    retryAfterSeconds?: number;
  } | null;
}

export interface TTSSegmentsEnsureResponse {
  documentId: string;
  segments: TTSSegmentManifestItem[];
}

export interface TTSSegmentVariant {
  segmentId: string;
  settings: TTSSegmentSettings | null;
  audioPresignUrl: string | null;
  audioFallbackUrl: string | null;
  durationMs: number | null;
  status: 'pending' | 'completed' | 'error';
  textLength: number;
  alignmentWordCount: number;
  audioKey: string | null;
  updatedAt: number | null;
}

export interface TTSSegmentRow {
  segmentIndex: number;
  /**
   * Content-stable identity for this segment, derived from the normalized
   * sentence text on the client (see `buildSegmentKey` in
   * `lib/shared/tts-segment-plan.ts`). The sidebar uses this to merge
   * locally-synthesized current-page rows with persisted manifest rows of the
   * same content, so audio/variants attach to the visible text row instead of
   * showing as a separate listing.
   */
  segmentKey: string | null;
  locator: TTSSegmentLocator | null;
  variants: TTSSegmentVariant[];
}

export interface TTSSegmentsManifestResponse {
  documentId: string;
  segments: TTSSegmentRow[];
  nextCursor: string | null;
  hasMore: boolean;
}
