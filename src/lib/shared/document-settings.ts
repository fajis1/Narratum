import {
  DEFAULT_DOCUMENT_SETTINGS,
  SMART_AUDIO_REVIEW_FLAG_KINDS,
  type DocumentSettings,
  type SmartAudioBookLexicon,
  type SmartAudioBookLexiconEntry,
  type SmartAudioCharacterMap,
  type SmartAudioReviewFlag,
} from '@/types/document-settings';
import { PARSED_PDF_BLOCK_KINDS, type ParsedPdfBlockKind } from '@/types/parsed-pdf';
import { normalizeLanguageTag } from '@/lib/shared/language';
import { normalizeSmartAudioCharacterMap } from '@/lib/shared/multi-voice';

function normalizeSkipKinds(value: unknown): ParsedPdfBlockKind[] {
  if (!Array.isArray(value)) return [...(DEFAULT_DOCUMENT_SETTINGS.pdf?.skipBlockKinds ?? [])];
  const allow = new Set(PARSED_PDF_BLOCK_KINDS);
  const out: ParsedPdfBlockKind[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    if (!allow.has(entry as ParsedPdfBlockKind)) continue;
    out.push(entry as ParsedPdfBlockKind);
  }
  return Array.from(new Set(out));
}

function normalizeLexicon(value: unknown): SmartAudioBookLexicon | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return undefined;
  if (record.status !== 'partial' && record.status !== 'complete') return undefined;
  if (typeof record.profileId !== 'string' || typeof record.pronunciationModel !== 'string') return undefined;
  if (typeof record.scannedAt !== 'number' || !Number.isFinite(record.scannedAt)) return undefined;
  if (!record.entries || typeof record.entries !== 'object') return undefined;

  const entries: Record<string, SmartAudioBookLexiconEntry> = {};
  for (const [key, rawEntry] of Object.entries(record.entries as Record<string, unknown>)) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as Record<string, unknown>;
    const term = typeof entry.term === 'string' ? entry.term.normalize('NFC').trim() : '';
    const pronunciation = typeof entry.pronunciation === 'string' ? entry.pronunciation.trim() : '';
    if (!term || !pronunciation) continue;
    const language = entry.language === 'koine_greek' || entry.language === 'biblical_hebrew'
      ? entry.language
      : 'other';
    entries[key.normalize('NFC')] = {
      term,
      pronunciation,
      definition: typeof entry.definition === 'string' && entry.definition.trim()
        ? entry.definition.trim()
        : null,
      language,
      ...(typeof entry.context === 'string' && entry.context.trim() ? { context: entry.context.trim() } : {}),
      ...(typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)
        ? { confidence: Math.max(0, Math.min(1, entry.confidence)) }
        : {}),
      ...(typeof entry.needsReview === 'boolean' ? { needsReview: entry.needsReview } : {}),
      ...(typeof entry.definitionOmitted === 'boolean' ? { definitionOmitted: entry.definitionOmitted } : {}),
      ...(entry.approvedRepair === true ? { approvedRepair: true } : {}),
    };
  }

  return {
    schemaVersion: 1,
    status: record.status,
    definitionScanComplete: record.definitionScanComplete === true,
    profileId: record.profileId,
    pronunciationModel: record.pronunciationModel,
    scannedAt: record.scannedAt,
    entries,
  };
}

export function normalizeSmartAudioReviewFlags(value: unknown): SmartAudioReviewFlag[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const flags: SmartAudioReviewFlag[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim().slice(0, 128) : '';
    const chapterIndex = Number(record.chapterIndex);
    const timestampMs = Number(record.timestampMs);
    const createdAt = Number(record.createdAt);
    if (!id || seen.has(id) || !Number.isInteger(chapterIndex) || chapterIndex < 0) continue;
    if (!Number.isFinite(timestampMs) || timestampMs < 0 || !Number.isFinite(createdAt) || createdAt <= 0) continue;
    seen.add(id);
    flags.push({
      id,
      chapterIndex,
      timestampMs: Math.round(timestampMs),
      createdAt: Math.round(createdAt),
      ...(typeof record.resolvedAt === 'number' && Number.isFinite(record.resolvedAt) && record.resolvedAt > 0
        ? { resolvedAt: Math.round(record.resolvedAt) }
        : {}),
      ...(SMART_AUDIO_REVIEW_FLAG_KINDS.includes(record.kind as (typeof SMART_AUDIO_REVIEW_FLAG_KINDS)[number]) ? {
        kind: record.kind as SmartAudioReviewFlag['kind'],
        ...(typeof record.speaker === 'string' ? { speaker: record.speaker.slice(0, 120) } : {}),
        ...(typeof record.sourceText === 'string' ? { sourceText: record.sourceText.slice(0, 4_000) } : {}),
        ...(typeof record.reason === 'string' ? { reason: record.reason.slice(0, 200) } : {}),
        ...(Number.isInteger(record.chunkIndex) && Number(record.chunkIndex) >= 0 ? { chunkIndex: Number(record.chunkIndex) } : {}),
        ...(Number.isInteger(record.attempts) && Number(record.attempts) >= 0 ? { attempts: Number(record.attempts) } : {}),
      } : {}),
    });
  }
  return flags.slice(-1_000);
}

export function mergeDocumentSettings(
  defaults: DocumentSettings = DEFAULT_DOCUMENT_SETTINGS,
  stored: unknown,
): DocumentSettings {
  const base: DocumentSettings = {
    schemaVersion: 1,
    language: defaults.language || 'auto',
    pdf: {
      skipBlockKinds: [...(defaults.pdf?.skipBlockKinds ?? [])],
    },
  };

  if (!stored || typeof stored !== 'object') return base;
  const rec = stored as Record<string, unknown>;
  const rawLanguage = typeof rec.language === 'string' ? rec.language.trim() : '';
  const language = !rawLanguage || rawLanguage.toLowerCase() === 'auto'
    ? 'auto'
    : normalizeLanguageTag(rawLanguage, defaults.language || 'en');
  const pdf = rec.pdf;
  const smartAudioLexicon = normalizeLexicon(rec.smartAudioLexicon);
  const smartAudioCharacters: SmartAudioCharacterMap | undefined = normalizeSmartAudioCharacterMap(
    rec.smartAudioCharacters,
  ) || undefined;
  const smartAudioReviewFlags = normalizeSmartAudioReviewFlags(rec.smartAudioReviewFlags);
  if (!pdf || typeof pdf !== 'object') {
    return {
      ...base,
      language,
      ...(smartAudioLexicon ? { smartAudioLexicon } : {}),
      ...(smartAudioCharacters ? { smartAudioCharacters } : {}),
      ...(smartAudioReviewFlags.length > 0 ? { smartAudioReviewFlags } : {}),
    };
  }
  const pdfRec = pdf as Record<string, unknown>;

  return {
    schemaVersion: 1,
    language,
    pdf: {
      skipBlockKinds: normalizeSkipKinds(pdfRec.skipBlockKinds),
    },
    ...(smartAudioLexicon ? { smartAudioLexicon } : {}),
    ...(smartAudioCharacters ? { smartAudioCharacters } : {}),
    ...(smartAudioReviewFlags.length > 0 ? { smartAudioReviewFlags } : {}),
  };
}

export function preserveServerManagedDocumentSettings(
  incoming: DocumentSettings,
  existing: DocumentSettings | null | undefined,
): DocumentSettings {
  const clientManagedIncoming = { ...incoming };
  delete clientManagedIncoming.smartAudioLexicon;
  delete clientManagedIncoming.smartAudioCharacters;
  delete clientManagedIncoming.smartAudioReviewFlags;
  return {
    ...clientManagedIncoming,
    ...(existing?.smartAudioLexicon
      ? { smartAudioLexicon: existing.smartAudioLexicon }
      : {}),
    ...(existing?.smartAudioCharacters
      ? { smartAudioCharacters: existing.smartAudioCharacters }
      : {}),
    ...(existing?.smartAudioReviewFlags
      ? { smartAudioReviewFlags: existing.smartAudioReviewFlags }
      : {}),
  };
}
