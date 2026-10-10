/** Document-local source evidence. Never a pronunciation-library alias. */
export interface SourceRecoveryOccurrence {
  id: string;
  groupId: string;
  surface: string;
  pdfPage: number;
  pageSourceStart: number;
  surfaceOccurrenceIndex?: number;
  surfaceOccurrenceCount?: number;
  bbox?: [number, number, number, number] | null;
  bboxKind?: 'text_block' | null;
  coordinateSource?: string | null;
  before: string;
  after: string;
  context: string;
  reasons: string[];
  requiresSourceRepair?: boolean;
  /** Retained audit evidence for an anchor disproved by a complete rescan. */
  anchorInvalidated?: boolean;
  status: 'unresolved' | 'proposed' | 'ambiguous' | 'approved' | 'rejected';
  proposal?: {
    correctedSurface: string;
    lemma: string | null;
    language: 'koine_greek' | 'biblical_hebrew' | 'other';
    explanation: string;
    visualEvidence?: 'text_block_crop_provided' | 'full_page_unlocalized';
    dictionary: { headword: string; source: string; morphology: string | null; definitions: string[] } | null;
    pronunciation: string | null;
    pronunciationReference: { scope: 'global' | 'personal'; term: string } | null;
  };
  reviewedAt?: number;
  analyzedAt?: number;
}
export type SourceRecoveryStage = 'pdf_loading' | 'pdf_rendering' | 'renderer_startup' | 'gemini_configuration'
  | 'gemini_request' | 'gemini_timeout' | 'response_parsing' | 'output_validation' | 'dictionary_lookup';
export interface SourceRecoveryAttempt {
  at: number;
  stage: 'gemini_request' | 'gemini_timeout';
  requestedModel?: string;
  model?: string;
  keyRole: 'primary' | 'backup';
  httpStatus?: number;
  errorCategory?: 'timeout' | 'transport' | 'cancelled';
  retryable: boolean;
  retryAfterMs?: number;
  attempt: number;
  fallbackAttempted: boolean;
  outcome: 'success' | 'failed' | 'cancelled';
}
export interface SourceRecoveryConfiguration {
  profileId: string;
  profileName: string;
  model: string;
  fallbackModels: string[];
  primaryKeyConfigured: boolean;
  backupKeyConfigured: boolean;
  automaticBackupFailover: boolean;
}
export interface SourceRecoveryAnalysis {
  schemaVersion: 1;
  documentId: string;
  revision: number;
  extractionVersion: number;
  /** Independent of candidate detection/cache changes; legacy v13 anchors are v1. */
  anchorVersion?: number;
  scannedAt: number;
  occurrences: SourceRecoveryOccurrence[];
  recoveryRun?: { status: 'paused' | 'completed' | 'provider_unavailable' | 'failed' | 'cancelled'; batchesCompleted: number; updatedAt: number; nextAttemptAt?: number };
  diagnostics: { at: number; groupId: string; attempted: boolean;
    outcome: 'proposed' | 'provider_error' | 'validation_rejected' | 'renderer_error' | 'configuration_error' | 'cancelled' | 'dictionary_warning';
    stage?: SourceRecoveryStage; httpStatus?: number; model?: string; message: string;
    usedBackup?: boolean; retryable?: boolean; retryAfterMs?: number; attempts?: SourceRecoveryAttempt[];
    configuration?: SourceRecoveryConfiguration; occurrenceIds?: string[] }[];
}
export interface SourceRecoverySnapshot {
  schemaVersion: 1;
  documentId: string;
  revision: number;
  occurrences: SourceRecoveryOccurrence[];
}
