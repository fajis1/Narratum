/** Document-local source evidence. Never a pronunciation-library alias. */
export interface SourceRecoveryOccurrence {
  id: string;
  groupId: string;
  surface: string;
  pdfPage: number;
  pageSourceStart: number;
  before: string;
  after: string;
  context: string;
  reasons: string[];
  status: 'unresolved' | 'proposed' | 'approved' | 'rejected';
  proposal?: {
    correctedSurface: string;
    lemma: string | null;
    language: 'koine_greek' | 'biblical_hebrew' | 'other';
    explanation: string;
    dictionary: { headword: string; source: string; morphology: string | null; definitions: string[] } | null;
    pronunciation: string | null;
    pronunciationReference: { scope: 'global' | 'personal'; term: string } | null;
  };
  reviewedAt?: number;
  analyzedAt?: number;
}
export interface SourceRecoveryAnalysis {
  schemaVersion: 1;
  documentId: string;
  revision: number;
  extractionVersion: number;
  scannedAt: number;
  occurrences: SourceRecoveryOccurrence[];
  diagnostics: { at: number; groupId: string; attempted: boolean; outcome: 'proposed' | 'provider_error' | 'validation_rejected'; httpStatus?: number; model?: string; message: string }[];
}
export interface SourceRecoverySnapshot {
  schemaVersion: 1;
  documentId: string;
  revision: number;
  occurrences: SourceRecoveryOccurrence[];
}
