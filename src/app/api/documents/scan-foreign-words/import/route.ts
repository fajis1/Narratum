import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { adminSettings } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { errorResponse } from '@/lib/server/errors/next-response';
import { serverLogger } from '@/lib/server/logger';
import { readBookLexicon, writeBookLexicon } from '@/lib/server/smart-audio/book-lexicon';
import { readSmartAudioProfilesDocument, findSmartAudioProfileById } from '@/lib/server/smart-audio-profiles';
import { parseForeignWordScanImport } from '@/lib/shared/foreign-word-scan-transfer';
import { isKokoroSafePronunciation } from '@/lib/shared/kokoro-pronunciation-policy';
import type { SmartAudioBookLexiconEntry } from '@/types/document-settings';

const GREEK = /\p{Script=Greek}/u;
const HEBREW = /\p{Script=Hebrew}/u;

function languageForWord(word: string): SmartAudioBookLexiconEntry['language'] {
  return HEBREW.test(word) ? 'biblical_hebrew' : GREEK.test(word) ? 'koine_greek' : 'other';
}

export async function POST(req: NextRequest) {
  try {
    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    const userId = ctxOrRes.userId;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const documentId = typeof body.documentId === 'string' ? body.documentId : '';
    const jobId = typeof body.jobId === 'string' ? body.jobId : '';
    if (!documentId || !jobId) return NextResponse.json({ error: 'Select a document and completed scan before importing.' }, { status: 400 });

    const key = `foreign_word_scan:${jobId}`;
    const [stored] = await db.select({ valueJson: adminSettings.valueJson }).from(adminSettings).where(eq(adminSettings.key, key)).limit(1);
    const job = typeof stored?.valueJson === 'string' ? JSON.parse(stored.valueJson) : stored?.valueJson;
    if (!job || job.userId !== userId || job.documentId !== documentId || !Array.isArray(job.words)) {
      return NextResponse.json({ error: 'Scan job not found for this document.' }, { status: 404 });
    }
    if (job.status === 'queued' || job.status === 'running') {
      return NextResponse.json({ error: 'Wait for the scan to finish before importing edits.' }, { status: 409 });
    }
    let changes;
    try {
      changes = parseForeignWordScanImport(body.scan, documentId, new Set(job.words.map((row: { word?: unknown }) => row.word).filter((word: unknown): word is string => typeof word === 'string')));
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid scan JSON.' }, { status: 400 });
    }

    const profiles = await readSmartAudioProfilesDocument(userId);
    const existing = await readBookLexicon(userId, documentId);
    const profileId = existing?.profileId || profiles.selectedProfileId;
    const profile = findSmartAudioProfileById(profiles, profileId);
    if (!profile) return NextResponse.json({ error: 'The scan profile is no longer available.' }, { status: 409 });
    const lexicon = existing || {
      schemaVersion: 1 as const, status: 'partial' as const, definitionScanComplete: false,
      profileId: profile.id, pronunciationModel: profile.pronunciationAiModel || profile.aiModel || '',
      scannedAt: Date.now(), entries: {} as Record<string, SmartAudioBookLexiconEntry>,
    };
    const rowsByWord = new Map<string, Record<string, unknown>>(job.words.map((row: Record<string, unknown>) => [String(row.word), row]));

    for (const change of changes) {
      const row = rowsByWord.get(change.word)!;
      const prior = lexicon.entries[change.word];
      const profileOverride = profile.pronunciations?.[change.word];
      if (change.pronunciation && profileOverride && profileOverride !== change.pronunciation) {
        return NextResponse.json({ error: `${change.word} has a personal profile pronunciation that would override the imported value. Edit that profile pronunciation first.` }, { status: 409 });
      }
      const pronunciation = change.pronunciation || prior?.pronunciation ||
        [row.userOverride, row.libraryPronunciation, row.geminiRecommendedPronunciation]
          .find((value): value is string => typeof value === 'string' && isKokoroSafePronunciation(change.word, value));
      if (!pronunciation) return NextResponse.json({ error: `A valid pronunciation is needed before importing a definition for ${change.word}.` }, { status: 400 });
    }

    const changeByWord = new Map(changes.map((change) => [change.word, change]));
    for (const change of changes) {
      const row = rowsByWord.get(change.word)!;
      const prior = lexicon.entries[change.word];
      const pronunciation = change.pronunciation || prior?.pronunciation ||
        [row.userOverride, row.libraryPronunciation, row.geminiRecommendedPronunciation]
          .find((value): value is string => typeof value === 'string' && isKokoroSafePronunciation(change.word, value))!;
      const definition = change.definition !== undefined ? change.definition : prior?.definition || (typeof row.definition === 'string' ? row.definition : null);
      lexicon.entries[change.word] = {
        ...prior, term: change.word, pronunciation, definition,
        definitionOmitted: definition === null,
        language: prior?.language || languageForWord(change.word),
        context: prior?.context || (Array.isArray(row.contexts) && typeof row.contexts[0] === 'string' ? row.contexts[0] : undefined),
        needsReview: false, approvedRepair: true,
      };
    }
    lexicon.scannedAt = Date.now();
    await writeBookLexicon(userId, documentId, lexicon);

    const updatedWords = job.words.map((row: Record<string, unknown>) => {
      const word = String(row.word);
      const change = changeByWord.get(word);
      if (!change) return row;
      const entry = lexicon.entries[word];
      const existingChoices = Array.isArray(row.pronunciations) ? row.pronunciations : [];
      const hasChoice = existingChoices.some((choice: unknown) => (typeof choice === 'string' ? choice : (choice as { phonetic?: unknown })?.phonetic) === entry.pronunciation);
      return {
        ...row,
        libraryPronunciation: entry.pronunciation,
        pronunciationSource: change.pronunciation ? 'imported' : row.pronunciationSource,
        pronunciations: hasChoice ? existingChoices : [{ phonetic: entry.pronunciation, isInGlobalLibrary: false }, ...existingChoices],
        definition: entry.definition,
        definitionOmitted: entry.definitionOmitted === true,
        definitionNeedsReview: false,
      };
    });
    const updatedJob = { ...job, words: updatedWords, updatedAt: Date.now() };
    await db.update(adminSettings).set({ valueJson: JSON.stringify(updatedJob) }).where(eq(adminSettings.key, key));
    return NextResponse.json({ imported: changes.length, words: updatedWords });
  } catch (error) {
    return errorResponse(error, {
      logger: serverLogger,
      event: 'pdf.scan.import.failed',
      msg: 'Failed to import foreign-word scan edits',
      apiErrorMessage: 'Failed to import scan edits.',
    });
  }
}
