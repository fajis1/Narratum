import { describe, expect, test } from 'vitest';

import {
  mergeDocumentSettings,
  preserveServerManagedDocumentSettings,
} from '../../src/lib/shared/document-settings';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_DOCUMENT_SETTINGS } from '../../src/types/document-settings';

describe('document settings language', () => {
  test('defaults to automatic language resolution', () => {
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, null).language).toBe('auto');
  });

  test('normalizes explicit BCP 47 language tags', () => {
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { language: 'zh-cn' }).language).toBe('zh-CN');
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { language: 'JA' }).language).toBe('ja');
  });

  test('preserves language when PDF settings are absent', () => {
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { language: 'fr' })).toMatchObject({
      language: 'fr',
      pdf: DEFAULT_DOCUMENT_SETTINGS.pdf,
    });
  });

  test('preserves a server-managed book lexicon across stale client saves', () => {
    const lexicon = {
      schemaVersion: 1 as const,
      status: 'complete' as const,
      definitionScanComplete: true,
      profileId: 'scholar',
      pronunciationModel: 'pronunciation-model',
      scannedAt: 123,
      entries: {},
    };
    const incoming = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, {
      language: 'fr',
    });
    const existing = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, {
      language: 'en',
      smartAudioLexicon: lexicon,
    });

    expect(preserveServerManagedDocumentSettings(incoming, existing)).toEqual({
      ...incoming,
      smartAudioLexicon: lexicon,
    });

    expect(preserveServerManagedDocumentSettings({
      ...incoming,
      smartAudioLexicon: lexicon,
    }, null)).toEqual(incoming);
  });

  test('preserves and normalizes server-managed character casts and mobile review flags', () => {
    const existing = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, {
      smartAudioCharacters: {
        schemaVersion: 1,
        status: 'complete',
        scannedAt: 123,
        profileId: 'litrpg',
        entries: {
          Narrator: { name: 'Narrator', description: '', sampleText: '', voiceId: 'af_heart' },
        },
      },
      smartAudioReviewFlags: [
        { id: 'flag-1', chapterIndex: 2, timestampMs: 12_345.4, createdAt: 456 },
        { id: '', chapterIndex: -1, timestampMs: -1, createdAt: 0 },
      ],
    });
    const incoming = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { language: 'fr' });
    const preserved = preserveServerManagedDocumentSettings(incoming, existing);

    expect(preserved.smartAudioCharacters?.profileId).toBe('litrpg');
    expect(preserved.smartAudioReviewFlags).toEqual([
      { id: 'flag-1', chapterIndex: 2, timestampMs: 12_345, createdAt: 456 },
    ]);
  });

  test('keeps Cloud Drama failure details for later review', () => {
    const settings = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, {
      smartAudioReviewFlags: [{
        id: 'cloud-1', chapterIndex: 1, timestampMs: 0, createdAt: 100,
        kind: 'cloud-tts-failed', speaker: 'Hero', sourceText: 'Keep this line.',
        reason: 'Cloud TTS HTTP 503', chunkIndex: 2, attempts: 3,
      }],
    });
    expect(settings.smartAudioReviewFlags?.[0]).toMatchObject({
      kind: 'cloud-tts-failed', speaker: 'Hero', sourceText: 'Keep this line.',
      reason: 'Cloud TTS HTTP 503', chunkIndex: 2, attempts: 3,
    });
  });

  test('preserves Cloud Drama diagnostic flags through normalization', () => {
    const settings = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, {
      smartAudioReviewFlags: ['cloud-tts-split', 'tts-retry-used', 'tts-fallback-used', 'director-validation-repair', 'prompt-compacted'].map((kind, index) => ({
        id: `diagnostic-${index}`, chapterIndex: 0, timestampMs: 0, createdAt: 100,
        kind: kind as 'cloud-tts-split', speaker: 'Hero', sourceText: 'A line.',
        reason: 'Needs a listening check.', chunkIndex: 0, attempts: 1,
      })),
    });
    expect(settings.smartAudioReviewFlags?.map((flag) => flag.kind)).toEqual([
      'cloud-tts-split', 'tts-retry-used', 'tts-fallback-used', 'director-validation-repair', 'prompt-compacted',
    ]);
  });

  test('document settings PUT preserves the latest lexicon atomically in the database', () => {
    const route = fs.readFileSync(
      path.join(process.cwd(), 'src/app/api/documents/[id]/settings/route.ts'),
      'utf8',
    );
    expect(route).toContain("${documentSettings.dataJson}->'smartAudioLexicon'");
    expect(route).toContain("json_extract(${documentSettings.dataJson}, '$.smartAudioLexicon')");
    expect(route).toContain("${documentSettings.dataJson}->'smartAudioCharacters'");
    expect(route).toContain("${documentSettings.dataJson}->'smartAudioReviewFlags'");
    expect(route).toContain("json_extract(${documentSettings.dataJson}, '$.smartAudioReviewFlags')");
    expect(route).toContain("'{needsRescan}', 'true'::jsonb");
    expect(route).toContain("'$.needsRescan', json('true')");
    expect(route).toContain('.returning({ dataJson: documentSettings.dataJson })');
  });
});
