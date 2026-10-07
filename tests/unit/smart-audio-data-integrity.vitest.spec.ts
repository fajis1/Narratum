import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const source = (relativePath: string) => fs.readFileSync(
  path.join(process.cwd(), relativePath),
  'utf8',
);

describe('Smart Audio data-integrity guards', () => {
  test('never masks Smart Audio failures with a developer-machine debug-file write', () => {
    const worker = source('src/lib/server/audiobooks/worker.ts');

    expect(worker).not.toContain('audiobook_err.txt');
    expect(worker).not.toContain("appendFileSync('/home/cisco/openreader");
    expect(worker).toContain("event: 'audiobook.queue.smart_audio.failed'");
    expect(worker).toContain("event: 'audiobook.queue.smart_audio.retry_scheduled'");
  });

  test('shows and persists the final Smart Audio title instead of the inherited blob title', () => {
    const statusRoute = source('src/app/api/audiobook/status/route.ts');
    const combineRoute = source('src/lib/server/audiobooks/combine.ts');
    const worker = source('src/lib/server/audiobooks/worker.ts');
    expect(statusRoute).toContain('titleByIndex.get(chapter.index) ?? chapter.title');
    expect(statusRoute.indexOf('title: audiobookChapters.title')).toBeLessThan(
      statusRoute.indexOf('titleByIndex.get(chapter.index) ?? chapter.title'),
    );
    expect(worker.indexOf('const resolvedChapterTitle')).toBeLessThan(
      worker.indexOf('const chapterFileName = encodeChapterFileName'),
    );
    expect(combineRoute.match(/title: titleByIndex\.get\(chapter\.index\) \?\? chapter\.title/g)).toHaveLength(1);
    expect(combineRoute.match(/title: chapter\.title,/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test('does not promote personal scan overrides into the global library', () => {
    const route = source('src/app/api/documents/scan-foreign-words/route.ts');
    expect(route).toContain('!compatibleOverrides[w]');
  });

  test('does not promote global Scholar defaults into the personal profile', () => {
    const worker = source('src/lib/server/audiobooks/worker.ts');
    expect(worker).toContain('termsNeedingGeneratedPronunciations');
    expect(worker).toContain('.filter((candidate) => !candidate.pronunciation)');
    expect(worker).toContain(
      '.filter((entry) => !entry.approvedRepair && termsNeedingGeneratedPronunciations.has(entry.term))',
    );
  });

  test('serializes every PostgreSQL Smart Audio profile writer with the same lock', () => {
    const profiles = source('src/lib/server/smart-audio-profiles.ts');
    expect(profiles).toContain('pg_advisory_xact_lock');
    expect(profiles.match(/lockSmartAudioProfilesRow\(tx, userId\)/g)).toHaveLength(4);
    expect(profiles).toContain('db.transaction((tx: typeof db) => {');
    expect(profiles).toContain('.limit(1).all();');
    expect(profiles).toContain('}).run();');
  });

  test('restores missing built-in profiles only through an explicit additive action', () => {
    const profiles = source('src/lib/server/smart-audio-profiles.ts');
    const route = source('src/app/api/tts-settings/route.ts');
    const settings = source('src/components/SmartAudioSettings.tsx');

    expect(profiles).toContain('restoreMissingBuiltInSmartAudioProfilesForUser');
    expect(profiles).toContain('const profiles = [...document.profiles, ...missingProfiles];');
    expect(profiles).toContain('if (result.restoredProfiles.length === 0) return result;');
    expect(route).toContain('body.restoreMissingBuiltInProfiles === true');
    expect(route).toContain('redactSmartAudioProfilesDocument(savedDoc)');
    expect(settings).toContain('Restore missing built-ins');
    expect(settings).toContain('body: JSON.stringify({ restoreMissingBuiltInProfiles: true })');
    expect(settings).toContain('return [...currentProfiles, ...missingFromClient];');
  });

  test('keeps global pronunciation and definition libraries separate and reusable', () => {
    const definitions = source('src/lib/server/smart-audio/global-definition-library.ts');
    const worker = source('src/lib/server/audiobooks/worker.ts');
    expect(definitions).toContain("const GLOBAL_DEFINITIONS_KEY = 'global_definitions';");
    expect(definitions).toContain('mergeGlobalDefinitions');
    expect(definitions).toContain('previewGlobalDefinitionImport');
    expect(worker).toContain('readGlobalDefinitions');
    expect(worker).toContain('globalDefinitions');
  });

  test('exports and imports the global definition library with pronunciation transfers', () => {
    const exportRoute = source('src/app/api/tts/global-pronunciations/export/route.ts');
    const importRoute = source('src/app/api/tts/global-pronunciations/route.ts');
    expect(exportRoute).toContain("format: 'openreader-global-dictionary'");
    expect(exportRoute).toContain('definitions');
    expect(exportRoute).toContain('readGlobalDefinitions');
    expect(importRoute).toContain('previewGlobalDefinitionImport');
    expect(importRoute).toContain('mergeGlobalDefinitions');
    expect(importRoute).toContain('importedDefinitions');
  });

  test('preflights every selected batch document before creating queue jobs', () => {
    const sidebar = source('src/components/doclist/BatchAudiobookSidebar.tsx');
    const preflight = sidebar.indexOf('preflightOnly: true');
    const queueLoop = sidebar.indexOf('let count = 0');
    expect(preflight).toBeGreaterThan(0);
    expect(queueLoop).toBeGreaterThan(preflight);
  });

  test('persists the same resolved Smart Audio profile used for preflight', () => {
    const route = source('src/app/api/audiobooks/queue/route.ts');
    expect(route).toContain('resolvedSmartAudioProfileId');
    expect(route).toContain('smartAudioProfileId: resolvedSmartAudioProfileId');
    expect(route).toContain('...resolvedSettingsRecord');
  });

  test('does not deduplicate Resume against a recently completed job', () => {
    const route = source('src/app/api/audiobooks/queue/route.ts');
    expect(route).toContain('const activeJob = existingJobs.find');
    expect(route).not.toContain('now - (j.createdAt || 0) < 5000');
  });

  test('never changes settings on an already-active audiobook job', () => {
    const route = source('src/app/api/audiobooks/queue/route.ts');
    const activeBlock = route.slice(
      route.indexOf('if (activeJob)'),
      route.indexOf('let resolvedSmartAudioProfileId'),
    );
    expect(activeBlock).not.toContain('db.update(audiobookJobs)');
    expect(activeBlock).not.toContain('settingsJson:');
    expect(route.indexOf('if (activeJob)')).toBeLessThan(
      route.indexOf("code: 'SCHOLAR_SCAN_REQUIRED'"),
    );
  });

  test('merges global replacements under a transaction and updates personal entries separately', () => {
    const route = source('src/app/api/tts/global-pronunciations/rescan/route.ts');
    const scanRoute = source('src/app/api/documents/scan-foreign-words/route.ts');
    const scanMerge = source('src/lib/server/smart-audio/global-pronunciation-merge.ts');
    expect(route).toContain('await db.transaction');
    expect(route).toContain('pg_advisory_xact_lock');
    expect(route).toContain('const latestLibrary = normalizeGlobalLibrary');
    expect(route).toContain('personalWords');
    expect(route).toContain('replacedPersonal');
    expect(route).toContain('mergeGeneratedPronunciationsIntoLatestProfile');
    expect(route).toContain('JSON.stringify(latestLibrary[word] || []) === JSON.stringify(library[word] || [])');
    expect(scanRoute).toContain('updatedGlobalWords');
    expect(scanRoute).toContain('globalDictAtScanStart');
    expect(scanRoute).toContain('mergeGeneratedGlobalPronunciations');
    expect(scanMerge).toContain('pg_advisory_xact_lock');
    expect(scanMerge).toContain("if (usePostgres) {");
    expect(scanMerge).toContain('database.transaction((tx: Database) => {');
    expect(scanMerge).toContain('.limit(1)\n      .all();');
    expect(scanMerge).toContain('globalLibraryUpsert(tx, latestLibrary).run();');
  });

  test('removes foreign passages at five words while preserving one-to-four-word terms', () => {
    const promptSources = [
      'src/components/constants.ts',
      'src/lib/server/default_smart_audio_profiles.json',
      'config/default_book_tts_settings.json',
    ].map(source);
    const wizard = source('src/components/SmartAudioWizardModal.tsx');

    for (const prompt of promptSources) {
      expect(prompt).toContain('5 or more words total');
      expect(prompt).toContain('1 to 4 words');
      expect(prompt).not.toContain('more than 5 words total');
      expect(prompt).not.toContain('1 to 5 words');
    }
    expect(wizard).toContain('5 or more words');
    expect(wizard).not.toContain('>5 words');
  });

  test('exposes the Batch Refine changelog beside the active Review progress banner', () => {
    const listener = source('src/app/(app)/listen/[bookId]/page.tsx');
    expect(listener).toContain('<ReviewJobStatus');
    expect(listener).toContain("reviewChanges={jobPresentation.reviewChanges}");
    expect(listener).toContain('/api/audiobooks/batch-refine/changelog?bookId=');
    expect(listener).toContain('onCancel={() => void cancelActiveJob()}');
    // Render/menu interaction contracts live in audiobook-review-components and
    // the real-page Playwright suite, including changelog/cancel overflow.

  });

  test('versions 12K chapter maps and retains legacy resume behavior', () => {
    const queueRoute = source('src/app/api/audiobooks/queue/route.ts');
    const worker = source('src/lib/server/audiobooks/worker.ts');
    const pipeline = source('src/lib/client/audiobooks/pipeline.ts');
    expect(queueRoute).toContain('queuedAudiobookBatchVersion(');
    expect(queueRoute).toContain('existingChapter.length > 0');
    expect(queueRoute).toContain('parseJobSettings(previousJob?.settingsJson)');
    expect(queueRoute).toContain("typeof value === 'string'");
    expect(worker).toContain('cleanupBatchTargetForVersion(jobSettings.cleanupBatchVersion)');
    expect(worker).toContain('if (usesCurrentBatching)');
    expect(worker).toContain("'audiobook.meta.json'");
    expect(pipeline).toContain(
      'let cleanupBatchVersion = CURRENT_AUDIOBOOK_BATCH_VERSION;',
    );
    expect(pipeline).toContain(
      'cleanupBatchVersion = existingData.settings?.cleanupBatchVersion ?? 1;',
    );
  });

  test('allows all capped global and personal pronunciation suspects to be rescanned', () => {
    const route = source('src/app/api/tts/global-pronunciations/rescan/route.ts');
    expect(route).toContain('const words = [...new Set([...globalWords, ...personalWords])];');
    expect(route).not.toMatch(/const (?:global|personal)Words = .*\.slice\(0, 50\)/);
    expect(route).toContain('const batchSize = 20;');
    expect(route).toContain('candidates.slice(offset, offset + batchSize)');
    expect(route).toContain('replacements[word][0].phonetic');
    expect(route).toContain('normalizeGeneratedPronunciation');
    expect(route).toContain('trimmed.replace(/^\\/|\\/$/g, \'\')');
    expect(route).toContain('Legacy global entries were often stored without slash wrappers');
    expect(route).toContain('const fallbackChoices');
    expect(route).toContain('const rejectedChoices = new Set');
    expect(route).toContain('!rejectedChoices.has(choice)');
    expect(route).toContain('better-sqlite3 transactions require a synchronous callback');
    expect(route).toContain('db.transaction((tx: typeof db) => {');
    expect(route).toContain('.limit(1)\n            .all();');
    expect(route).toContain('}).run();');

  });

  test('audits both global and selected-profile pronunciation libraries before repair', () => {
    const route = source('src/app/api/tts/global-pronunciations/rescan/route.ts');
    expect(route).toContain('export async function GET');
    expect(route).toContain('const globalSuspects');
    expect(route).toContain('const personalSuspects');
    expect(route).toContain("profile?.pronunciations || {}");
    expect(route).toContain('globalWords: [...new Set(globalSuspects.map');
    expect(route).toContain('personalWords: [...new Set(personalSuspects.map');
    expect(route).toContain('Do not mix Erasmian, historical, modern, or reconstructed systems');
  });

  test('gives direct 12K cleanup requests the mode-aware worker timeout', () => {
    const route = source('src/app/api/audiobook/chapter/route.ts');
    expect(route).toContain(
      'timeout: resolveSmartAudioNatsTimeoutMs(selectedProfile?.workerMode)',
    );
  });

  test('places final pronunciation checks after dynamic guidance and before source text', () => {
    for (const workerPath of ['audiobook_worker.py', 'biblical_scholar_worker.py']) {
      const worker = source(workerPath);
      expect(worker).toContain('final_cleanup_rules = data.get("final_cleanup_rules", "")');
      expect(worker).toContain(
        '{title_instruction}{final_cleanup_rules}\\n\\n{repair_instruction}Original text to clean:',
      );
    }

    const backgroundWorker = source('src/lib/server/audiobooks/worker.ts');
    const directRoute = source('src/app/api/audiobook/chapter/route.ts');
    expect(backgroundWorker).toContain('final_cleanup_rules: FINAL_SMART_AUDIO_PRONUNCIATION_CHECK');
    expect(directRoute).toContain('final_cleanup_rules: FINAL_SMART_AUDIO_PRONUNCIATION_CHECK');
  });

  test('applies document PDF exclusions in the background worker before batching', () => {
    const worker = source('src/lib/server/audiobooks/worker.ts');
    expect(worker).toContain('mergeDocumentSettings(');
    expect(worker).toContain('preparePdfAudiobookBlocks({');
    expect(worker.indexOf('preparePdfAudiobookBlocks({')).toBeLessThan(
      worker.indexOf('batchAudiobookText('),
    );
  });

  test('requires confirmed positional end matter before allowing a large omission', () => {
    const worker = source('src/lib/server/audiobooks/worker.ts');
    const endMatter = source('src/lib/shared/audiobook-end-matter.ts');
    const cleanup = source('src/lib/shared/smart-audio-cleanup.ts');

    expect(endMatter).toContain('AUDIOBOOK_END_MATTER_START_FRACTION = 0.7');
    expect(worker).toContain('allowSubstantialOmission: confirmedEndMatter');
    expect(worker).toContain('>= AUDIOBOOK_END_MATTER_START_FRACTION');
    const endMatterTransition = worker.slice(
      worker.indexOf('if (startsConfirmedEndMatter && !isInEndMatter)'),
      worker.indexOf('if (currentLength >= cleanupTargetCharacters)', worker.indexOf('if (startsConfirmedEndMatter && !isInEndMatter)')),
    );
    expect(endMatterTransition.indexOf('flush();')).toBeLessThan(
      endMatterTransition.indexOf('isInEndMatter = true'),
    );
    expect(cleanup).toContain('OpenReader emits that hint only at or after 70% through the book');
  });

  test('fails closed instead of sending raw text when direct cleanup fails', () => {
    const route = source('src/app/api/audiobook/chapter/route.ts');
    const worker = source('src/lib/server/audiobooks/worker.ts');
    expect(route).toContain('resolveSmartAudioWorkerResult(candidate, {');
    expect(route).toContain('Refusing to synthesize uncleaned text.');
    expect(route).not.toContain('NATS failed. Falling back to raw text.');
    expect(route).toContain('validateSmartAudioOutput(processedTextForTts');
    expect(worker).toContain('validateSmartAudioOutput(processedTextForTts');
  });

  test('keeps private PDF markers out of the saved original text', () => {
    const worker = source('src/lib/server/audiobooks/worker.ts');
    expect(worker).toContain('cleanupText: chapter.text');
    expect(worker).toContain('text: stripSmartAudioInputMarkers(chapter.text)');
    expect(worker).toContain('chapter.cleanupText ?? chapter.text');
    expect(worker).toContain("Buffer.from(chapter.text, 'utf8')");
  });

  test('requires Python workers to report cleaned or omitted explicitly', () => {
    for (const workerPath of ['audiobook_worker.py', 'biblical_scholar_worker.py']) {
      const worker = source(workerPath);
      expect(worker).toContain('raise RuntimeError("Gemini returned no text; expected cleaned text or [OMIT]")');
      expect(worker).toContain('"outcome": outcome');
      expect(worker).toContain('outcome = "omitted"');
      expect(worker).toContain('QUALITY_REPAIR_MODEL = "gemini-3.8-flash"');
      expect(worker).toContain('"model_used": ai_model');
    }
  });

  test('escalates rejected cleanup output and preserves substantial source text after a repeated omission', () => {
    const recovery = source('src/lib/server/audiobooks/smart-audio-validation-recovery.ts');
    const backgroundWorker = source('src/lib/server/audiobooks/worker.ts');
    const directRoute = source('src/app/api/audiobook/chapter/route.ts');

    expect(recovery).toContain('resolveSmartAudioValidationRepairModel(requestedModel)');
    for (const caller of [backgroundWorker, directRoute]) {
      expect(caller).toContain('sourceFallback: (rejectedResult) => ({');
      expect(caller).toContain('sourceFallbackUsed');
      expect(caller).toContain('source_fallback: true');
    }
  });

  test('uses the source document identity for direct Scholar lexicon lookup', () => {
    const route = source('src/app/api/audiobook/chapter/route.ts');
    const pipeline = source('src/lib/client/audiobooks/pipeline.ts');
    expect(route).toContain('const sourceDocumentId = data.documentId || bookId;');
    expect(route).toContain('readBookLexicon(storageUserId, sourceDocumentId)');
    expect(pipeline).toContain('documentId: sourceDocumentId');
  });

  test('reconciles known pronunciations without learning cleanup output in both generation paths', () => {
    for (const path of [
      'src/lib/server/audiobooks/worker.ts',
      'src/app/api/audiobook/chapter/route.ts',
    ]) {
      const implementation = source(path);
      expect(implementation).toContain('authoritativePronunciations');
      expect(implementation).toContain('resolveSmartAudioWithValidationRecovery({');
      expect(implementation).not.toContain('selectUnknownSmartAudioPronunciations(');
      expect(implementation).not.toContain('workerResult.new_pronunciations');
    }
  });

  test('gives validation failures one correction before discarding only unsafe tags', () => {
    for (const path of [
      'src/lib/server/audiobooks/worker.ts',
      'src/app/api/audiobook/chapter/route.ts',
    ]) {
      const implementation = source(path);
      expect(implementation).toContain('buildSmartAudioValidationRepairPayload(');
      expect(implementation).toContain('smart_audio.validation_repair');
      expect(implementation).toContain('smart_audio.pronunciation_fallback');
    }
    for (const workerPath of ['audiobook_worker.py', 'biblical_scholar_worker.py']) {
      const worker = source(workerPath);
      expect(worker).toContain('VALIDATION FEEDBACK:');
      expect(worker).toContain('REJECTED CLEANED OUTPUT:');
      expect(worker).toContain('remove only its [word](/IPA/)');
      expect(worker).not.toContain('new_pronunciations');
      expect(worker).not.toContain('extract_learned_words');
    }
  });

  test('offers an explicit Scholar auto-scan when regenerating a chapter', () => {
    const route = source('src/app/api/audiobook/chapter/route.ts');
    const modal = source('src/components/AudiobookExportModal.tsx');
    const client = source('src/lib/client/api/audiobooks.ts');
    expect(route).toContain('confirmScholarAutoScan');
    expect(route).toContain('resolveSmartAudioBookLexicon({');
    expect(route).toContain("status: 'partial'");
    expect(client).toContain('err.code = data?.code');
    expect(modal).toContain('pendingScholarRegeneration');
    expect(modal).toContain('handleRegenerateChapter(chapter, true)');
  });

  test('preflights direct Scholar regeneration before quota and isolates profile lexicons', () => {
    const route = source('src/app/api/audiobook/chapter/route.ts');
    expect(route.indexOf("code: 'SCHOLAR_SCAN_REQUIRED'")).toBeLessThan(
      route.indexOf('rateLimiter.checkAndIncrementLimit('),
    );
    expect(route).toContain(
      "const previousBookLexicon = bookLexicon?.profileId === selectedProfile.id",
    );
    expect(route).toContain('existing: previousBookLexicon');
    expect(route).toContain(
      'filterKokoroCompatiblePronunciationRecord(globalCandidates)',
    );
  });

  test('marks replacements for incompatible old global choices as Gemini recommendations', () => {
    const route = source('src/app/api/documents/scan-foreign-words/route.ts');
    expect(route).toContain('preExistingCompatibleGlobalWords');
    expect(route).toContain('preExistingCompatibleGlobalPhonetics');
    expect(route).toContain('!preExistingCompatibleGlobalWords.has(w)');
  });
});
