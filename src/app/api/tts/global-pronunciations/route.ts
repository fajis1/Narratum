import { scanPronunciationActionError } from '@/lib/server/smart-audio/scan-pronunciation-guard';
import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/db';
import { adminSettings } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { requireAdminContext } from '@/lib/server/auth/admin';
import {
  normalizeGlobalPronunciationLibrary,
  normalizeGlobalPronunciation,
  promoteHumanGlobalPronunciation,
  recordLearnedGlobalPronunciation,
  removeGlobalPronunciationChoice,
  replaceGlobalPronunciationChoices,
  setGlobalPronunciationDefault,
  previewGlobalPronunciationImport,
  type GlobalPronunciationLibrary,
} from '@/lib/server/tts/global-pronunciation-library';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { findSmartAudioProfileById, readSmartAudioProfilesDocument } from '@/lib/server/smart-audio-profiles';
import { errorResponse } from '@/lib/server/errors/next-response';
import { serverLogger } from '@/lib/server/logger';
import {
  mergeGlobalDefinitions,
  previewGlobalDefinitionImport,
  readGlobalDefinitions,
} from '@/lib/server/smart-audio/global-definition-library';

const DEFAULT_SEED_PRONUNCIATIONS: Record<string, string[]> = {
  "Eather": ["/iːθər/"],
  "Eatheral": ["/iːθərəl/"],
  "Aetherian": ["/iːθərɪən/"],
  "stumbled": ["/stʌmbəld/"],
  "bottomed-out": ["/bɒtəmd aʊt/"],
  "launched": ["/lɔːntʃt/"],
  "face-planted": ["/feɪs plæntəd/"],
  "Aetherians": ["/iːθərɪənz/"],
  "Avinian": ["/əvɪniən/"],
  "qŏdāšîm": ["/koʊdɑʃim/"],
  "qādôš": ["/kɑdoʊʃ/"],
  "λόγος": ["/lɒɡɒs/"],
  "καταλλάσσω": ["/kɑtɑlɑsoʊ/"],
  "בְּרִית": ["/bəɹiθ/"]
};

type GlobalLibraryMutationResult<T> = {
  result: T;
  changed: boolean;
};

async function mutateGlobalPronunciationLibrary<T>(
  mutation: (library: GlobalPronunciationLibrary) => GlobalLibraryMutationResult<T>,
): Promise<T> {
  let mutationResult = { result: undefined as T, changed: false };
  let completed = false;
  if (process.env.POSTGRES_URL) {
    await db.transaction(async (tx: typeof db) => {
      await tx.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended('openreader:global_pronunciations', 0)
        )
      `);
      const latestRows = await tx
        .select({ valueJson: adminSettings.valueJson })
        .from(adminSettings)
        .where(eq(adminSettings.key, 'global_pronunciations'))
        .limit(1);
      const latestLibrary = normalizeGlobalPronunciationLibrary(latestRows[0]?.valueJson || {});
      mutationResult = mutation(latestLibrary);
      completed = true;
      if (!mutationResult.changed) return;
      await tx.insert(adminSettings).values({
        key: 'global_pronunciations',
        valueJson: JSON.stringify(latestLibrary),
      }).onConflictDoUpdate({
        target: adminSettings.key,
        set: { valueJson: JSON.stringify(latestLibrary) },
      });
    });
  } else {
    db.transaction((tx: typeof db) => {
      const latestRows = tx
        .select({ valueJson: adminSettings.valueJson })
        .from(adminSettings)
        .where(eq(adminSettings.key, 'global_pronunciations'))
        .limit(1)
        .all();
      const latestLibrary = normalizeGlobalPronunciationLibrary(latestRows[0]?.valueJson || {});
      mutationResult = mutation(latestLibrary);
      completed = true;
      if (!mutationResult.changed) return;
      tx.insert(adminSettings).values({
        key: 'global_pronunciations',
        valueJson: JSON.stringify(latestLibrary),
      }).onConflictDoUpdate({
        target: adminSettings.key,
        set: { valueJson: JSON.stringify(latestLibrary) },
      }).run();
    });
  }
  if (!completed) throw new Error('Global pronunciation transaction did not complete.');
  return mutationResult.result;
}

export async function GET() {
  try {
    const rows = await db
      .select({ valueJson: adminSettings.valueJson })
      .from(adminSettings)
      .where(eq(adminSettings.key, 'global_pronunciations'))
      .limit(1);

    let parsed: unknown = {};
    if (!rows || rows.length === 0 || !rows[0].valueJson) {
      // Seed initial global dictionary with default prepopulated pronunciations
      parsed = DEFAULT_SEED_PRONUNCIATIONS;
      await db.insert(adminSettings).values({
        key: 'global_pronunciations',
        valueJson: JSON.stringify(DEFAULT_SEED_PRONUNCIATIONS)
      }).onConflictDoUpdate({
        target: adminSettings.key,
        set: { valueJson: JSON.stringify(DEFAULT_SEED_PRONUNCIATIONS) }
      });
    } else {
      const value = rows[0].valueJson;
      parsed = typeof value === 'string' ? JSON.parse(value) : value;
    }

    return NextResponse.json(normalizeGlobalPronunciationLibrary(parsed));
  } catch (error) {
    serverLogger.error({ event: 'tts.global_pronunciations.read.failed', error }, 'Failed to get global pronunciations');
    return NextResponse.json({});
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const isImportPreviewAction = body.action === 'preview-import';
    const isImportAction = body.action === 'import';
    if (isImportPreviewAction || isImportAction) {
      const admin = await requireAdminContext(req);
      if (admin instanceof Response) return admin;
      const preview = previewGlobalPronunciationImport(body.library);
      const definitionsValue = body.library && typeof body.library === 'object'
        ? (body.library as { definitions?: unknown }).definitions
        : undefined;
      const definitionPreview = previewGlobalDefinitionImport(definitionsValue);
      if (isImportPreviewAction) {
        return NextResponse.json({
          validWords: preview.validWords,
          validChoices: preview.validChoices,
          issues: preview.issues,
          validDefinitions: definitionPreview.validDefinitions,
          definitionIssues: definitionPreview.issues,
        });
      }
      if (preview.validWords === 0 && definitionPreview.validDefinitions === 0) {
        return NextResponse.json({
          error: 'No safe global pronunciations or usable definitions were found in this import.',
          issues: preview.issues,
          definitionIssues: definitionPreview.issues,
        }, { status: 400 });
      }
      const replaceExisting = body.mode === 'replace-imported';
      const result = preview.validWords > 0 ? await mutateGlobalPronunciationLibrary((latestLibrary) => {
        let importedWords = 0;
        let importedChoices = 0;
        for (const [word, imported] of Object.entries(preview.library)) {
          const existing = replaceExisting ? [] : (latestLibrary[word] || []);
          const combined = [...existing, ...imported]
            .filter((choice, index, choices) => choices.findIndex(
              (candidate) => candidate.phonetic === choice.phonetic,
            ) === index)
            .slice(0, 5);
          if (JSON.stringify(existing) !== JSON.stringify(combined)) {
            latestLibrary[word] = combined;
            importedWords += 1;
            importedChoices += replaceExisting
              ? combined.length
              : combined.filter((choice) => !existing.some((current) => current.phonetic === choice.phonetic)).length;
          }
        }
        return {
          result: { importedWords, importedChoices },
          changed: importedWords > 0,
        };
      }) : { importedWords: 0, importedChoices: 0 };
      const existingDefinitions = await readGlobalDefinitions();
      const definitionsToImport = Object.fromEntries(
        Object.entries(definitionPreview.definitions).filter(([term]) => (
          replaceExisting || !existingDefinitions[term]
        )),
      );
      const importedDefinitions = await mergeGlobalDefinitions(definitionsToImport);
      serverLogger.info({
        event: 'tts.global_pronunciations.imported',
        importedWords: result.importedWords,
        importedChoices: result.importedChoices,
        rejectedChoices: preview.issues.length,
        importedDefinitions: importedDefinitions.length,
        rejectedDefinitions: definitionPreview.issues.length,
        replaceExisting,
      }, 'Imported validated global pronunciations');
      return NextResponse.json({
        ...result,
        validWords: preview.validWords,
        validChoices: preview.validChoices,
        issues: preview.issues,
        importedDefinitions: importedDefinitions.length,
        validDefinitions: definitionPreview.validDefinitions,
        definitionIssues: definitionPreview.issues,
      });
    }

    const word = typeof body.word === 'string' ? body.word.trim() : '';
    const phonetic = typeof body.phonetic === 'string' ? body.phonetic : '';
    const isReplaceAction = body.action === 'replace-choices';
    const isDeleteWordAction = body.action === 'delete-word';
    const isPersonalPromotionAction = body.action === 'promote-personal-default';
    const isPhoneticAction = body.action === 'set-default' || body.action === 'delete-choice';
    if (!word || (isReplaceAction && !Array.isArray(body.choices))) {
      return NextResponse.json({ error: 'Missing word or replacement choices' }, { status: 400 });
    }
    if (!phonetic && !isReplaceAction && !isDeleteWordAction) {
      return NextResponse.json({ error: 'Missing phonetic' }, { status: 400 });
    }

    if (isPersonalPromotionAction) {
      const auth = await requireAuthContext(req);
      if (auth instanceof Response) return auth;
      const normalized = normalizeGlobalPronunciation(phonetic);
      if (!normalized) {
        return NextResponse.json({ error: 'The personal pronunciation is not safe Kokoro IPA.' }, { status: 400 });
      }
      const scanError = await scanPronunciationActionError(auth.userId, body.scanContext, word, true);
      if (scanError) return NextResponse.json({ error: scanError }, { status: 409 });
      const profilesDocument = await readSmartAudioProfilesDocument(auth.userId);
      const activeProfile = findSmartAudioProfileById(
        profilesDocument,
        profilesDocument.selectedProfileId,
      );
      if (normalizeGlobalPronunciation(activeProfile?.pronunciations?.[word]) !== normalized) {
        return NextResponse.json({
          error: 'Save this pronunciation to the selected personal profile before promoting it globally.',
        }, { status: 409 });
      }
      const updatedList = await mutateGlobalPronunciationLibrary((currentGlobal) => {
        const promoted = promoteHumanGlobalPronunciation(currentGlobal[word] || [], normalized);
        if (promoted) currentGlobal[word] = promoted;
        return { result: promoted, changed: promoted !== null };
      });
      serverLogger.info({
        event: 'tts.global_pronunciations.personal_default_promoted',
        word,
      }, 'Promoted a verified personal pronunciation to the global default');
      return NextResponse.json({ success: true, updatedList });
    }

    if (isPhoneticAction || isReplaceAction || isDeleteWordAction) {
      const admin = await requireAdminContext(req);
      if (admin instanceof Response) return admin;

      if (isDeleteWordAction) {
        const deleted = await mutateGlobalPronunciationLibrary((latestLibrary) => {
          if (!Object.prototype.hasOwnProperty.call(latestLibrary, word)) {
            return { result: false, changed: false };
          }
          delete latestLibrary[word];
          return { result: true, changed: true };
        });
        if (!deleted) {
          return NextResponse.json({ error: 'Global pronunciation word not found.' }, { status: 404 });
        }
        return NextResponse.json({ success: true });
      }

      if (body.action === 'delete-choice') {
        const removal = await mutateGlobalPronunciationLibrary((latestLibrary) => {
          const next = removeGlobalPronunciationChoice(latestLibrary, word, phonetic);
          if (next.removed) {
            if (next.choices.length > 0) latestLibrary[word] = next.choices;
            else delete latestLibrary[word];
          }
          return { result: next, changed: next.removed };
        });
        if (!removal.removed) {
          return NextResponse.json({ error: 'Global pronunciation choice not found.' }, { status: 404 });
        }
        return NextResponse.json({ success: true, updatedList: removal.choices });
      }

      const buildUpdatedList = (latestLibrary: GlobalPronunciationLibrary) => (
        body.action === 'set-default'
          ? setGlobalPronunciationDefault(latestLibrary, word, phonetic)
          : replaceGlobalPronunciationChoices(word, body.choices, body.defaultIndex)
      );
      const updatedList = await mutateGlobalPronunciationLibrary((latestLibrary) => {
        const next = buildUpdatedList(latestLibrary);
        if (next) latestLibrary[word] = next;
        return { result: next, changed: next !== null };
      });
      if (!updatedList) {
        return NextResponse.json({
          error: 'All global pronunciations must be valid, safe slash-delimited Kokoro IPA values.',
        }, { status: 400 });
      }
      return NextResponse.json({ success: true, updatedList });
    }

    const updatedList = await mutateGlobalPronunciationLibrary((currentGlobal) => {
      const existingList = currentGlobal[word] || [];
      const learnedList = recordLearnedGlobalPronunciation(existingList, phonetic);
      currentGlobal[word] = learnedList;
      return { result: learnedList, changed: learnedList !== existingList };
    });

    return NextResponse.json({ success: true, updatedList });
  } catch (error) {
    return errorResponse(error, {
      logger: serverLogger,
      event: 'tts.global_pronunciations.update.failed',
      msg: 'Failed to update global pronunciations',
      apiErrorMessage: 'Failed to update global pronunciations.',
    });
  }
}
