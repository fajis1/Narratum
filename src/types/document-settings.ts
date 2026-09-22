import type { ParsedPdfBlockKind } from '@/types/parsed-pdf';

export interface SmartAudioBookLexiconEntry {
  term: string;
  pronunciation: string;
  definition: string | null;
  definitionOmitted?: boolean;
  language: 'koine_greek' | 'biblical_hebrew' | 'other';
  context?: string;
  confidence?: number;
  needsReview?: boolean;
  /** Explicitly remembered from an approved repair, scoped to this book. */
  approvedRepair?: boolean;
}

export interface SmartAudioBookLexicon {
  schemaVersion: 1;
  status: 'partial' | 'complete';
  definitionScanComplete: boolean;
  profileId: string;
  pronunciationModel: string;
  scannedAt: number;
  entries: Record<string, SmartAudioBookLexiconEntry>;
}

/**
 * Stable per-character direction for the `drama-gemini-tts` worker mode.
 *
 * This is the LEVEL 1 Character Direction (plan §5.3) — it describes who
 * the character IS acoustically and their default performance baseline.
 * It is stored in the cast entry and persists across all chapters.
 *
 * The Gemini Drama Director uses this to remain consistent between segments
 * (e.g. Bethany always sounds authoritative-but-warm, Vistan always calm-intense).
 *
 * The Kokoro Drama path NEVER reads or writes this field.
 */
export interface DramaCharacterDirection {
  /**
   * A 1–3 sentence acoustic/personality profile sent to Gemini-TTS.
   * This is what the character SOUNDS LIKE by nature — age, affect, warmth,
   * authority, texture — not their current emotional state.
   *
   * Examples:
   *   Bethany: "A woman in her 30s with a naturally calm, warm voice that carries
   *   quiet authority. She rarely raises her voice; her intensity comes from
   *   stillness and precision."
   *
   *   Vistan: "A deep male voice with a measured, deliberate cadence.
   *   Authority built into the baseline — not from loudness, but from certainty."
   */
  audioProfile: string;

  /**
   * Default delivery for this character when no special moment direction applies.
   * The Drama Director can override any of these on a per-segment basis.
   */
  defaultPerformance?: {
    /** Baseline speaking pace: 'slow' | 'measured' | 'moderate' | 'brisk' | 'fast' */
    pace?: string;
    /** Baseline energy level: 'low' | 'moderate' | 'high' */
    energy?: string;
    /** Baseline emotional intensity: 'subdued' | 'controlled' | 'moderate' | 'heightened' | 'intense' */
    intensity?: string;
    /** Default delivery style(s) for this character, e.g. ['thoughtful', 'warm'] */
    delivery?: string[];
  };

  /**
   * Optional technical voice overrides applied on every request for this character.
   * These supplement the style prompt and do not replace emotional direction.
   */
  technicalOverrides?: {
    /**
     * Speaking rate multiplier (0.25–2.0, per Google Cloud TTS spec).
     * 1.0 = normal speed. Use sparingly; prefer pace direction in the style prompt.
     */
    speakingRate?: number;
    /**
     * Pitch adjustment in semitones (-20.0 to 20.0, per Google Cloud TTS spec).
     * Use sparingly; prefer the style prompt for character voice shaping.
     */
    pitch?: number;
  };
}

export interface SmartAudioCharacterEntry {
  name: string;
  description: string;
  sampleText: string;
  voiceId?: string | null;
  aliasFor?: string | null;
  /**
   * Optional per-character direction for the `drama-gemini-tts` mode.
   * Not present on Kokoro Drama cast entries — the Kokoro path ignores this field.
   */
  cloudDirection?: DramaCharacterDirection | null;
}

export interface SmartAudioCharacterMap {
  schemaVersion: 1;
  status: 'partial' | 'complete';
  scannedAt: number;
  profileId?: string;
  sourceFingerprint?: string;
  needsRescan?: boolean;
  entries: Record<string, SmartAudioCharacterEntry>;
}

export interface SmartAudioReviewFlag {
  id: string;
  chapterIndex: number;
  timestampMs: number;
  createdAt: number;
  resolvedAt?: number | null;
  kind?: 'cloud-tts-failed';
  speaker?: string;
  sourceText?: string;
  reason?: string;
  chunkIndex?: number;
  attempts?: number;
}

export interface DocumentSettings {
  schemaVersion: 1;
  language?: string;
  pdf?: {
    skipBlockKinds: ParsedPdfBlockKind[];
  };
  smartAudioLexicon?: SmartAudioBookLexicon;
  smartAudioCharacters?: SmartAudioCharacterMap;
  smartAudioReviewFlags?: SmartAudioReviewFlag[];
}

export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = {
  schemaVersion: 1,
  language: 'auto',
  pdf: {
    skipBlockKinds: ['header', 'footer', 'footnote', 'vision_footnote'],
  },
};
