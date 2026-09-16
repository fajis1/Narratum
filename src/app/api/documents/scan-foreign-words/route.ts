import { after, NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { serverLogger } from '@/lib/server/logger';
import { getDocumentBlob } from '@/lib/server/documents/blobstore';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { readSmartAudioProfilesDocument, findSmartAudioProfileById } from '@/lib/server/smart-audio-profiles';
import { buildKokoroPronunciationInstructions, isKokoroSafePronunciation } from '@/lib/shared/kokoro-pronunciation-policy';
import { resolvePronunciationAiModel } from '@/lib/shared/smart-audio-models';
import {
  isCompleteScholarScanScope,
  readBookLexicon,
  writeBookLexicon,
} from '@/lib/server/smart-audio/book-lexicon';
import type {
  SmartAudioBookLexicon,
  SmartAudioBookLexiconEntry,
} from '@/types/document-settings';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import util from 'util';
import { db } from '@/db';
import { adminSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { generateTTSBuffer } from '@/lib/server/tts/generate';
import { resolveTtsCredentials } from '@/lib/server/admin/resolve-credentials';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { normalizeGeminiTokenUsage } from '@/lib/server/smart-audio/gemini-usage';
import { fetchGeminiWithRateLimitFallback } from '@/lib/server/smart-audio/gemini-failover';
import { mergeGeneratedGlobalPronunciations } from '@/lib/server/smart-audio/global-pronunciation-merge';
import { mergeGlobalDefinitions, readGlobalDefinitions } from '@/lib/server/smart-audio/global-definition-library';
import {
  createGeminiHttpError,
  collectGeminiPronunciationRepairRequests,
  foreignWordCandidateCacheKey,
  GEMINI_FOREIGN_WORD_RESPONSE_JSON_SCHEMA,
  GeminiHttpError,
  type GeminiForeignWordResult,
  mergeGeminiPronunciationRepairResults,
  isRejectedLatinTransliteration,
  isUsableForeignWordCandidate,
  parseForeignWordCandidateCache,
  parseGeminiForeignWordResults,
} from '@/lib/server/smart-audio/gemini-foreign-word-scan';
import {
  normalizeDictionaryDefinition,
  shouldOmitDictionaryDefinition,
} from '@/lib/shared/dictionary-definition-policy';
import { findTransliterationLibraryMatch } from '@/lib/server/smart-audio/transliteration-library-match';
import { fetchGroqForeignWordBatch } from '@/lib/server/smart-audio/groq-foreign-word-scan';
import { fetchLexiconEntries } from '@/lib/server/smart-audio/sefaria-lexicon';
import { DEFAULT_PROVIDER_ORDER } from '@/types/client';

const execFileAsync = util.promisify(execFile);
const GREEK = /[\u0370-\u03ff\u1f00-\u1fff]/u;
const HEBREW = /[\u0590-\u05ff]/u;

class ScanCancelledError extends Error {
  constructor() {
    super('Scan cancelled by user.');
    this.name = 'ScanCancelledError';
  }
}

function languageForTerm(term: string): SmartAudioBookLexiconEntry['language'] {
  if (HEBREW.test(term)) return 'biblical_hebrew';
  if (GREEK.test(term)) return 'koine_greek';
  return 'other';
}

export async function POST(req: NextRequest) {
  try {
    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    const userId = ctxOrRes.userId;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    
    const body = await req.json();
    const documentId = typeof body.documentId === 'string' ? body.documentId : '';
    if (!documentId) return NextResponse.json({ error: 'Missing documentId' }, { status: 400 });

    const mode = body.mode || 'all_foreign';
    // A partial scan cannot certify a Scholar audiobook as ready. Keep this
    // server-side as well as in the UI so callers cannot accidentally create
    // another 80% scan that later fails the audiobook preflight.
    const target = 100;
    const query = body.query || null;
    const generateOnlyForNewWords = body.generateOnlyForNewWords !== false;
    const forceUseBackupKey = body.forceUseBackupKey === true;

    const jobId = randomUUID();
    const jobKey = `foreign_word_scan:${jobId}`;

    const initialJobState = {
      id: jobId,
      userId,
      documentId,
      status: 'queued',
      stage: 'extracting',
      words: [],
      total: 0,
      completed: 0,
      resolved: 0,
      librarySkipped: 0,
      transliterationRejected: 0,
      errors: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await db.insert(adminSettings).values({
      key: jobKey,
      valueJson: JSON.stringify(initialJobState),
    }).onConflictDoUpdate({
      target: adminSettings.key,
      set: { valueJson: JSON.stringify(initialJobState) },
    });

    after(async () => {
      const jobState: Record<string, unknown> = { ...initialJobState };
      const ensureScanNotCancelled = async () => {
        const rows = await db.select({ valueJson: adminSettings.valueJson })
          .from(adminSettings)
          .where(eq(adminSettings.key, jobKey))
          .limit(1);
        const current = rows[0]?.valueJson;
        const parsed = typeof current === 'string' ? JSON.parse(current) : current;
        if (parsed && typeof parsed === 'object' && (parsed as { status?: unknown }).status === 'cancelled') {
          throw new ScanCancelledError();
        }
      };
      const saveJob = async (patch: Record<string, unknown>) => {
        if (patch.status !== 'cancelled') await ensureScanNotCancelled();
        Object.assign(jobState, patch, { updatedAt: Date.now() });
        await db.insert(adminSettings).values({
          key: jobKey,
          valueJson: JSON.stringify(jobState),
        }).onConflictDoUpdate({
          target: adminSettings.key,
          set: { valueJson: JSON.stringify(jobState) },
        });
      };

      try {
        await saveJob({ status: 'running', stage: 'extracting' });
        const testNamespace = getOpenReaderTestNamespace(req.headers);
        const candidateCacheKey = foreignWordCandidateCacheKey({
          userId,
          documentId,
          mode,
          target,
          query,
        });
        const cachedRows = await db.select({ valueJson: adminSettings.valueJson })
          .from(adminSettings)
          .where(eq(adminSettings.key, candidateCacheKey))
          .limit(1);
        let words = parseForeignWordCandidateCache(cachedRows[0]?.valueJson) as any[] | null;
        if (words) {
          serverLogger.info(
            { event: 'pdf.scan.candidates.cache_hit', documentId, mode, target },
            'Reusing cached PDF foreign-word candidates',
          );
        } else {
          const pdfBlob = await getDocumentBlob(documentId, testNamespace);

          // write to temp file
          const tempFilePath = path.join(os.tmpdir(), `scan-${documentId}-${Date.now()}.pdf`);
          await fs.writeFile(tempFilePath, pdfBlob);

          // Call python script
          let stdout: string;
          try {
            serverLogger.info({ event: 'pdf.scan.started', documentId, mode, target }, 'Starting PDF foreign words pre-scan Python process...');
            const pythonBin = path.join(process.cwd(), '.venv', 'bin', 'python3');

            const args = [
              'scan_pdf_foreign_words.py',
              tempFilePath,
              '--mode', mode,
              '--target', target.toString(),
              '--json'
            ];
            if (query) {
              args.push('--query', query);
            }

            const result = await execFileAsync(pythonBin, args, {
              cwd: process.cwd(),
              maxBuffer: 10 * 1024 * 1024
            });
            stdout = result.stdout;
            serverLogger.info({ event: 'pdf.scan.completed', documentId }, 'PDF foreign words pre-scan Python process completed');
          } finally {
            await fs.unlink(tempFilePath).catch(() => {});
          }

          words = JSON.parse(stdout);
          if (!Array.isArray(words)) {
            throw new Error('PDF foreign-word scanner returned an invalid candidate list.');
          }
          const cachedCandidates = JSON.stringify({ version: 10, words });
          await db.insert(adminSettings).values({
            key: candidateCacheKey,
            valueJson: cachedCandidates,
            source: 'runtime',
          }).onConflictDoUpdate({
            target: adminSettings.key,
            set: {
              valueJson: cachedCandidates,
              source: 'runtime',
              updatedAt: Date.now(),
            },
          });
        }

        if (mode !== 'custom') {
          const originalCount = words.length;
          words = words.filter(isUsableForeignWordCandidate);
          const skippedPhraseCandidates = originalCount - words.length;
          if (skippedPhraseCandidates > 0) {
            serverLogger.info(
              { event: 'pdf.scan.candidates.filtered', documentId, skippedPhraseCandidates },
              'Excluded non-lexical multi-word or IPA-key foreign-word candidates',
            );
          }
        }

        // Fetch global pronunciations
        const globalRows = await db.select().from(adminSettings).where(eq(adminSettings.key, 'global_pronunciations')).limit(1);
        let globalDict: Record<string, any[]> = {};
        if (globalRows.length > 0 && globalRows[0].valueJson) {
          try {
            const parsed = typeof globalRows[0].valueJson === 'string' ? JSON.parse(globalRows[0].valueJson) : globalRows[0].valueJson;
            for (const [k, v] of Object.entries(parsed)) {
              if (Array.isArray(v)) {
                globalDict[k] = v.map((item: any) => typeof item === 'string' ? { phonetic: item, usageCount: 0 } : item);
              } else if (typeof v === 'string') {
                globalDict[k] = [{ phonetic: v, usageCount: 0 }];
              }
            }
          } catch (e) {}
        }

        const profilesDoc = await readSmartAudioProfilesDocument(userId);
        const activeProfile = findSmartAudioProfileById(profilesDoc, profilesDoc.selectedProfileId);
        const globalDefinitions = await readGlobalDefinitions();
        
        const overrides = activeProfile?.pronunciations || {};
        const compatibleOverrides = Object.fromEntries(
          Object.entries(overrides).filter(([word, pronunciation]) => (
            isKokoroSafePronunciation(word, pronunciation)
          )),
        );
        const preExistingGlobalWords = new Set(Object.keys(globalDict));
        const preExistingCompatibleGlobalPhonetics = new Map(
          Object.entries(globalDict).map(([word, choices]) => [
            word,
            new Set(
              choices
                .map((choice) => choice?.phonetic)
                .filter((pronunciation): pronunciation is string => (
                  isKokoroSafePronunciation(word, pronunciation)
                )),
            ),
          ]),
        );
        const preExistingCompatibleGlobalWords = new Set(
          [...preExistingCompatibleGlobalPhonetics.entries()]
            .filter(([, pronunciations]) => pronunciations.size > 0)
            .map(([word]) => word),
        );
        const geminiRecommendations: Record<string, string> = {};
        const existingLexicon = await readBookLexicon(userId, documentId);
        const lexiconEntries: Record<string, SmartAudioBookLexiconEntry> = {
          ...(activeProfile && existingLexicon?.profileId === activeProfile.id ? existingLexicon.entries : {}),
        };
        for (const [term, entry] of Object.entries(lexiconEntries)) {
          const normalizedDefinition = normalizeDictionaryDefinition(entry.definition);
          if (entry.definition && normalizedDefinition !== entry.definition) {
            lexiconEntries[term] = {
              ...entry,
              definition: normalizedDefinition,
              definitionOmitted: normalizedDefinition === null,
              needsReview: normalizedDefinition === null ? false : entry.needsReview,
            };
          }
          if (!entry.definition && globalDefinitions[term]) {
            lexiconEntries[term] = {
              ...lexiconEntries[term],
              definition: globalDefinitions[term],
              definitionOmitted: false,
            };
          }
        }
        const aliasLibraryTerms = new Set([
          ...Object.keys(globalDict),
          ...Object.keys(globalDefinitions),
          ...Object.keys(compatibleOverrides),
          ...Object.keys(lexiconEntries),
        ]);
        const aliasLibraryRecords = Object.fromEntries([...aliasLibraryTerms].map((term) => {
          const globalPronunciation = (globalDict[term] || [])
            .map((choice) => choice?.phonetic)
            .find((pronunciation) => isKokoroSafePronunciation(term, pronunciation));
          return [term, {
            pronunciation: compatibleOverrides[term]
              || lexiconEntries[term]?.pronunciation
              || globalPronunciation
              || null,
            definition: lexiconEntries[term]?.definition || globalDefinitions[term] || null,
          }];
        }));
        const transliterationMatches = new Map<string, ReturnType<typeof findTransliterationLibraryMatch>>();
        for (const w of words) {
          if (typeof w.word !== 'string') continue;
          const match = findTransliterationLibraryMatch(w.word, aliasLibraryRecords);
          if (match) transliterationMatches.set(w.word, match);
        }
        for (const w of words) {
          const term = w.word;
          if (!term || typeof term !== 'string') continue;
          const transliterationMatch = transliterationMatches.get(term);
          const userPron = compatibleOverrides[term] || null;
          const globalPron = preExistingCompatibleGlobalWords.has(term)
            ? globalDict[term]
              ?.map((choice) => choice?.phonetic)
              .find((pronunciation) => isKokoroSafePronunciation(term, pronunciation)) || null
            : null;
          const aliasPronunciation = transliterationMatch?.pronunciation
            && isKokoroSafePronunciation(term, transliterationMatch.pronunciation)
            ? transliterationMatch.pronunciation
            : null;
          const libraryPron = userPron || globalPron || aliasPronunciation;
          const libraryDefinition = globalDefinitions[term]
            || transliterationMatch?.definition
            || null;
          if (libraryPron) {
            lexiconEntries[term] = {
              ...lexiconEntries[term],
              term,
              pronunciation: libraryPron,
              definition: lexiconEntries[term]?.definition || libraryDefinition,
              definitionOmitted: lexiconEntries[term]?.definitionOmitted === true
                ? true
                : libraryDefinition ? false : undefined,
              language: languageForTerm(term) === 'other' && transliterationMatch
                ? languageForTerm(transliterationMatch.sourceTerm)
                : languageForTerm(term),
              context: Array.isArray(w.contexts) ? w.contexts[0] : undefined,
            };
          }
        }
        const needsScholarDefinition = activeProfile?.workerMode === 'scholar';
        const automaticOcrFragments = new Set<string>(
          words
            .filter((word: any) => word?.ocrFragment === true)
            .map((word: any) => word.word),
        );
        const rejectedLatinTransliterations = new Set<string>();

        // Pre-fetch Sefaria (and Perseus for Greek) lexicon data for biblical-language words.
        // Best-effort: failures are non-fatal and return null for that word.
        const biblicalWordLanguages = words
          .filter((w: any) => typeof w.word === 'string')
          .map((w: any) => ({ word: w.word as string, language: languageForTerm(w.word) }));
        const lexiconEnrichments = await fetchLexiconEntries(biblicalWordLanguages);

        const wordsMissingOptions = words
          .filter((w: any) => {
            if (automaticOcrFragments.has(w.word)) return false;
            const transliterationPronunciation = transliterationMatches.get(w.word)?.pronunciation;
            const compatibleGlobalChoices = (globalDict[w.word] || []).filter((choice) => (
              isKokoroSafePronunciation(w.word, choice?.phonetic)
            ));
            const needsPronunciations = !compatibleOverrides[w.word]
              && !(
                transliterationPronunciation
                && isKokoroSafePronunciation(w.word, transliterationPronunciation)
              )
              && (compatibleGlobalChoices.length === 0
                || (!generateOnlyForNewWords && compatibleGlobalChoices.length < 5));
            const language = languageForTerm(w.word);
            const lexiconEntry = lexiconEntries[w.word];
            const needsDefinition = needsScholarDefinition
              && language !== 'other'
              && (!lexiconEntry || (
                lexiconEntry.language !== 'other'
              && !lexiconEntry.definition
                && !globalDefinitions[w.word]
                && lexiconEntry.definitionOmitted !== true
              ));
            return needsPronunciations || needsDefinition;
          })
          .map((w: any) => w.word);
        const librarySkipped = Math.max(
          0,
          words.length - automaticOcrFragments.size - wordsMissingOptions.length,
        );
        const updatedGlobalWords = new Set<string>();
        const confirmedOcrFragments = new Set<string>(automaticOcrFragments);
        const resolvedGeminiWords = new Set<string>();
        let acceptedChoices = 0;
        let updatedLexicon = false;
        let terminalGeminiError: string | null = null;

        const enrichWords = () => words.map((w: any) => {
          const transliterationMatch = transliterationMatches.get(w.word);
          const userPronunciation = compatibleOverrides[w.word] || null;
          const globalPronunciation = preExistingCompatibleGlobalWords.has(w.word)
            ? globalDict[w.word]
              ?.map((choice) => choice?.phonetic)
              .find((pronunciation) => isKokoroSafePronunciation(w.word, pronunciation)) || null
            : null;
          const transliterationPronunciation = transliterationMatch?.pronunciation
            && isKokoroSafePronunciation(w.word, transliterationMatch.pronunciation)
            ? transliterationMatch.pronunciation
            : null;
          const libraryPronunciation = userPronunciation || globalPronunciation || transliterationPronunciation;
          const globalChoices = (globalDict[w.word] || []).map((item: any) => ({
            ...(typeof item === 'string' ? { phonetic: item } : item),
            isInGlobalLibrary: preExistingCompatibleGlobalPhonetics
              .get(w.word)
              ?.has(item?.phonetic) === true,
          }));
          if (
            transliterationPronunciation
            && !globalChoices.some((choice: any) => choice.phonetic === transliterationPronunciation)
          ) {
            globalChoices.unshift({
              phonetic: transliterationPronunciation,
              isInGlobalLibrary: true,
              isTransliterationMatch: true,
            });
          }

          return {
            ...w,
            pronunciations: generateOnlyForNewWords && preExistingGlobalWords.has(w.word)
              ? globalChoices.slice(0, 1)
              : globalChoices,
            userOverride: userPronunciation,
            libraryPronunciation,
            pronunciationSource: userPronunciation ? 'personal' : globalPronunciation ? 'global' : transliterationPronunciation ? 'transliteration' : geminiRecommendations[w.word] ? 'gemini' : 'none',
            transliterationSourceTerm: transliterationMatch?.sourceTerm || null,
            geminiRecommendedPronunciation: geminiRecommendations[w.word] || null,
            definition: lexiconEntries[w.word]?.definition || null,
            definitionOmitted: lexiconEntries[w.word]?.definitionOmitted === true,
            definitionNeedsReview: lexiconEntries[w.word]?.needsReview === true,
            ocrSuspect: w.ocrSuspect === true,
            ocrFragment: confirmedOcrFragments.has(w.word),
            automaticIgnore: w.automaticIgnore === true || rejectedLatinTransliterations.has(w.word),
            automaticIgnoreReason: rejectedLatinTransliterations.has(w.word)
              ? 'Gemini did not recognize this rare Latin term as Koine Greek or Biblical Hebrew transliteration'
              : w.automaticIgnoreReason,
          };
        });

        const globalDictAtScanStart = JSON.parse(JSON.stringify(globalDict)) as Record<string, any[]>;
        await saveJob({
          stage: 'generating',
          words: enrichWords(),
          total: wordsMissingOptions.length,
          completed: 0,
          librarySkipped,
        });



        if (wordsMissingOptions.length > 0) {
          if (!activeProfile?.geminiApiKey && !activeProfile?.backupGeminiApiKey && !activeProfile?.groqApiKey) {
            throw new Error('No API key is configured for the selected Smart Audio profile. Add a Gemini key or a free Groq API key in Smart Audio Settings.');
          }
          const model = resolvePronunciationAiModel(activeProfile);
          let effectiveModel = model;
          const apiKey = (forceUseBackupKey && activeProfile?.backupGeminiApiKey)
            ? activeProfile.backupGeminiApiKey
            : (activeProfile?.geminiApiKey || activeProfile?.backupGeminiApiKey || '');
      
      const chunkSize = 35;
          for (let i = 0; i < wordsMissingOptions.length; i += chunkSize) {
        await ensureScanNotCancelled();
        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        const chunk = wordsMissingOptions.slice(i, i + chunkSize);
        const libraryAtBatchStart = JSON.parse(JSON.stringify(globalDict)) as Record<string, any[]>;
        const batchUpdatedWords = new Set<string>();
        const terms = chunk.map((word: string) => {
          const scanned = words.find((item: any) => item.word === word);
          const transliterationPronunciation = transliterationMatches.get(word)?.pronunciation;
          const storedPronunciation = compatibleOverrides[word]
            || (globalDict[word] || [])
              .map((choice) => choice?.phonetic)
              .find((choice) => isKokoroSafePronunciation(word, choice))
            || (transliterationPronunciation && isKokoroSafePronunciation(word, transliterationPronunciation)
              ? transliterationPronunciation
              : null);
          const wordLexicon = lexiconEnrichments.get(word) ?? null;
          return {
            term: word,
            contexts: Array.isArray(scanned?.contexts) ? scanned.contexts.slice(0, 2) : [],
            currentPronunciation: storedPronunciation || null,
            ocrSuspect: scanned?.ocrSuspect === true,
            ocrEvidence: Array.isArray(scanned?.ocrEvidence) ? scanned.ocrEvidence.slice(0, 2) : [],
            editorialSpellings: Array.isArray(scanned?.editorialSpellings) ? scanned.editorialSpellings.slice(0, 2) : [],
            latinTransliterationCandidate: scanned?.latinTransliterationCandidate === true,
            // Sefaria / Perseus lexicon enrichment (null when not available)
            ...(wordLexicon ? { lexiconEntry: wordLexicon } : {}),
          };
        });
        const prompt = `${buildKokoroPronunciationInstructions(activeProfile)}

Create pronunciation choices and short audiobook definitions for these terms.
Where a "lexiconEntry" field is present in a term's data, it contains ground-truth lexical data from academic sources (BDB, Jastrow, LSJ, or Perseus). Treat the provided definitions as authoritative; generate IPA consistent with the supplied transliteration and morphology. Do not contradict or override the lexicon definitions.
Internal Greek/Hebrew editorial parentheses have been expanded for lookup: θε(οῦ) requests θεοῦ as one word. editorialSpellings preserves the printed notation. Include those letters in the complete pronunciation; this is a narration convention, not a manuscript judgment. Never pronounce only the prefix or suffix.
For each term without currentPronunciation, return 5 distinct, plausible Kokoro IPA pronunciation variations and put the best first, except for a rejected Latin transliteration candidate as described below.
If currentPronunciation is supplied, preserve it exactly and return it as the only pronunciation; do not generate extra variations.
For Koine Greek or Biblical Hebrew, use the supplied contexts to return a contextual English definition of one to four words.
When latinTransliterationCandidate is true, decide from the spelling and supplied context whether the term is genuinely a Latin-letter transliteration of Koine Greek or Biblical Hebrew. If it is, classify it as koine_greek or biblical_hebrew and provide its pronunciation and contextual definition normally. If it is ordinary English, a proper name, Latin, another language, or otherwise not a credible biblical-language transliteration, set language to other, return pronunciations as [], definition as null, definitionOmitted as true, and needsReview as false. Never invent a biblical-language identity merely because the word is uncommon.
Return exactly one meaning, never a comma-, slash-, semicolon-, "and"-, or "or"-separated list of synonyms or alternatives.
Do not return a definition that consists only of a common function or connecting word such as "the", "or", "of", "off", or "like"; return null and set definitionOmitted to true instead.
If the surrounding book context already states the definition, return that same concise gloss; OpenReader will recognize the author-supplied definition and will not speak it twice.
Set language to "koine_greek", "biblical_hebrew", or "other". For other languages, abbreviations, or invented names, set language to "other" and definition to null.
If a token is an OCR fragment, an unidentifiable fragment, or an inflected form with no reliable contextual English gloss, return definition as null and definitionOmitted as true. Never use placeholder text such as "Fragment or inflected form" as a definition.
When ocrSuspect is true, inspect ocrEvidence before deciding. Set ocrFragment to true only if that raw mixed-script/bracketed OCR token proves the requested term is a damaged fragment. For a confirmed OCR fragment return pronunciations as [], language as "other", definition as null, definitionOmitted as true, and needsReview as false. Do not attempt to reconstruct or invent a replacement term.
For all other terms set ocrFragment to false.
Otherwise return a useful contextual definition and set definitionOmitted to false.
Return a JSON array with exactly one result object per requested term. Copy each requested term exactly into that result object's "term" field.

Terms:
${JSON.stringify(terms)}`;
        
        // requestGeminiResults is assigned per-batch to whichever Gemini provider
        // succeeds, so the quality-repair pass reuses the same key automatically.
        let requestGeminiResults: (
          requestPrompt: string,
          pass: 'pronunciation_definition_scan' | 'pronunciation_quality_repair',
        ) => Promise<GeminiForeignWordResult[]> = async () => [];

        try {
          // Build the effective provider sequence from the profile's providerOrder
          // (or the default), skipping any provider whose key isn't configured.
          const orderedProviders = (activeProfile?.providerOrder ?? DEFAULT_PROVIDER_ORDER)
            .filter((provider) => {
              if (provider === 'gemini_primary') return Boolean(activeProfile?.geminiApiKey);
              if (provider === 'gemini_backup') return Boolean(activeProfile?.backupGeminiApiKey);
              if (provider === 'groq') return Boolean(activeProfile?.groqApiKey);
              return false;
            });

          if (orderedProviders.length === 0) {
            throw new Error('No configured API key matched the selected provider order. Check your Smart Audio Profile settings.');
          }

          let generated: GeminiForeignWordResult[] = [];
          let lastError: unknown = null;
          let providerSucceeded = false;

          for (const provider of orderedProviders) {
            try {
              if (provider === 'groq') {
                await saveJob({ statusMessage: `Trying Groq (${orderedProviders.indexOf(provider) + 1}/${orderedProviders.length})…` });
                generated = await fetchGroqForeignWordBatch(prompt, activeProfile!.groqApiKey!);
              } else {
                // Gemini providers each get their own single key; internal retry/model
                // fallback is still handled by fetchGeminiWithRateLimitFallback.
                const geminiKey = provider === 'gemini_primary'
                  ? activeProfile!.geminiApiKey!
                  : activeProfile!.backupGeminiApiKey!;
                const providerLabel = provider === 'gemini_primary' ? 'Gemini primary' : 'Gemini backup';
                const requestGeminiSingleKey = async (
                  requestPrompt: string,
                  pass: 'pronunciation_definition_scan' | 'pronunciation_quality_repair',
                ) => {
                  const { response: res, usedModel } = await fetchGeminiWithRateLimitFallback({
                    primaryApiKey: geminiKey,
                    requestedModel: model,
                    onStatusUpdate: async (statusMessage) => { await saveJob({ statusMessage }); },
                    request: (requestApiKey, requestModel) => fetch(
                      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(requestModel || model)}:generateContent?key=${encodeURIComponent(requestApiKey)}`,
                      {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          contents: [{ role: 'user', parts: [{ text: requestPrompt }] }],
                          generationConfig: {
                            responseMimeType: 'application/json',
                            maxOutputTokens: 8192,
                            responseJsonSchema: GEMINI_FOREIGN_WORD_RESPONSE_JSON_SCHEMA,
                          },
                        }),
                      },
                    ),
                  });
                  const data = await res.json().catch(() => null);
                  effectiveModel = usedModel || model;
                  if (!res.ok) throw createGeminiHttpError(res.status, data, [geminiKey]);
                  serverLogger.info({
                    event: 'pdf.scan.gemini.usage',
                    jobId, documentId,
                    model: usedModel || model,
                    requestedModel: model,
                    provider,
                    pass,
                    batch: i / chunkSize + 1,
                    tokens: normalizeGeminiTokenUsage(data?.usageMetadata),
                  }, 'Recorded Gemini pronunciation and definition scan token usage.');
                  const generatedText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                  if (!generatedText) throw new Error('Gemini returned no pronunciation choices.');
                  const { results, repaired } = parseGeminiForeignWordResults(generatedText);
                  if (repaired) {
                    serverLogger.warn(
                      { event: 'pdf.scan.gemini.json_repaired', jobId, pass, batch: i / chunkSize + 1 },
                      'Recovered complete results from a truncated Gemini JSON array',
                    );
                  }
                  return results;
                };
                // Expose this key's request function as the batch-level requestGeminiResults
                // so the repair pass below can reuse it for the same provider.
                // We store it on a mutable ref scoped to this iteration.
                requestGeminiResults = requestGeminiSingleKey;
                await saveJob({ statusMessage: `Trying ${providerLabel} key (${orderedProviders.indexOf(provider) + 1}/${orderedProviders.length})…` });
                generated = await requestGeminiSingleKey(prompt, 'pronunciation_definition_scan');
              }
              providerSucceeded = true;
              await saveJob({ statusMessage: null });
              break; // success — stop trying providers
            } catch (providerErr) {
              lastError = providerErr;
              const isLast = provider === orderedProviders.at(-1);
              const errMsg = providerErr instanceof Error ? providerErr.message : String(providerErr);
              serverLogger.warn({
                event: 'pdf.scan.provider.failed',
                jobId,
                provider,
                batch: i / chunkSize + 1,
                error: errMsg.slice(0, 300),
                willTryNext: !isLast,
              }, isLast
                ? 'All configured providers failed for this batch'
                : `Provider failed; advancing to next in order`);
              if (!isLast) {
                const nextProvider = orderedProviders[orderedProviders.indexOf(provider) + 1];
                await saveJob({ statusMessage: `${provider.replace('_', ' ')} failed — trying ${nextProvider?.replace('_', ' ')}…` });
              }
            }
          }

          if (!providerSucceeded) {
            throw lastError ?? new Error('All configured providers failed.');
          }

          const repairRequests = collectGeminiPronunciationRepairRequests(terms, generated);
          if (repairRequests.length > 0) {
            const repairPrompt = `${buildKokoroPronunciationInstructions(activeProfile)}

This is the only automatic correction pass for these terms. Your previous response violated OpenReader's Kokoro pronunciation policy or omitted required choices.
Return only the listed terms, using the same JSON response structure. Correct every listed violation and provide exactly choicesNeeded new, distinct choices for each term.
Do not return any rejected pronunciation or repeat an accepted pronunciation.
Never place /y/ directly beside /j/ and never repeat /j/; choose one appropriate glide.
For an initialism, return separated single English capital letters such as /K, T, L/, never grouped capitals such as /K, TL/ or /TH, N/.
Copy each term exactly. Preserve its language and contextual meaning. Do not add terms that are not listed.

Corrections:
${JSON.stringify(repairRequests)}`;

            await saveJob({
              statusMessage: `Correcting ${repairRequests.length} pronunciation ${repairRequests.length === 1 ? 'result' : 'results'} (one automatic pass)…`,
            });
            try {
              const repairs = await requestGeminiResults(repairPrompt, 'pronunciation_quality_repair');
              generated = mergeGeminiPronunciationRepairResults(generated, repairs);
            } catch (repairError) {
              serverLogger.warn({
                event: 'pdf.scan.gemini.quality_repair.failed',
                error: repairError instanceof Error ? repairError.message : 'Unknown Gemini correction error',
                jobId,
                batch: i / chunkSize + 1,
              }, 'The single Gemini pronunciation quality correction pass failed');
              if (repairError instanceof GeminiHttpError && repairError.status === 400) {
                throw repairError;
              }
            } finally {
              await saveJob({ statusMessage: null });
            }
          }

          const unresolvedQualityTerms = new Set(
            collectGeminiPronunciationRepairRequests(terms, generated)
              .map((request) => request.term),
          );
          if (unresolvedQualityTerms.size > 0) {
            serverLogger.warn({
              event: 'pdf.scan.gemini.quality_unresolved',
              terms: [...unresolvedQualityTerms],
              jobId,
              batch: i / chunkSize + 1,
            }, 'Pronunciations still require review after the single automatic correction pass');
          }

          const acceptedWords = new Set<string>();
          const requestedTerms = new Map(chunk.map((term: string) => [term, term]));
          for (const result of generated) {
            const w = requestedTerms.get(result.term);
            if (w) {
              const scanned = words.find((item: any) => item.word === w);
              const requestedTerm = terms.find((term) => term.term === w);
              if (requestedTerm && isRejectedLatinTransliteration(requestedTerm, result)) {
                // Latin candidates are deliberately broad enough to find
                // unknown transliterations. Gemini-confirmed non-biblical
                // terms stay visible only in the ignored count and never
                // enter a book, profile, or global pronunciation library.
                rejectedLatinTransliterations.add(w);
                acceptedWords.add(w);
                continue;
              }
              if (scanned?.ocrSuspect === true && result.ocrFragment === true) {
                // Gemini, not a brittle local heuristic, made the final call.
                // Do not let a confirmed OCR shard reuse or create a global entry.
                confirmedOcrFragments.add(w);
                if (Object.prototype.hasOwnProperty.call(lexiconEntries, w)) {
                  delete lexiconEntries[w];
                  updatedLexicon = true;
                }
                acceptedWords.add(w);
                continue;
              }
              const prons = Array.isArray(result.pronunciations) ? result.pronunciations : [];
              const current = (globalDict[w] || []).filter((choice) => (
                isKokoroSafePronunciation(w, choice?.phonetic)
              ));
              const existingPhonetics = new Set(current.map(c => c.phonetic));

              for (const p of prons) {
                if (
                  !compatibleOverrides[w]
                  && isKokoroSafePronunciation(w, p)
                  && !existingPhonetics.has(p)
                  && current.length < 5
                ) {
                  if (!geminiRecommendations[w]) geminiRecommendations[w] = p;
                  current.push({ phonetic: p, usageCount: 0, isUserCustom: false, timestamp: Date.now() });
                  existingPhonetics.add(p);
                  acceptedChoices += 1;
                  acceptedWords.add(w);
                  batchUpdatedWords.add(w);
                  updatedGlobalWords.add(w);
                }
              }
              globalDict[w] = current;

              const pronunciation = compatibleOverrides[w]
                || current[0]?.phonetic
                || (transliterationMatches.get(w)?.pronunciation
                  && isKokoroSafePronunciation(w, transliterationMatches.get(w)?.pronunciation)
                  ? transliterationMatches.get(w)?.pronunciation
                  : null)
                || prons.find((candidate: string) => isKokoroSafePronunciation(w, candidate));
              if (pronunciation) {
                if (!geminiRecommendations[w] && !compatibleOverrides[w] && !preExistingCompatibleGlobalWords.has(w)) {
                  geminiRecommendations[w] = pronunciation;
                }
                const definitionOmitted = result.definitionOmitted === true
                  || shouldOmitDictionaryDefinition(result.definition);
                const definition = definitionOmitted
                  ? null
                  : normalizeDictionaryDefinition(result.definition)
                    || transliterationMatches.get(w)?.definition
                    || null;
                const transliterationSourceLanguage = languageForTerm(
                  transliterationMatches.get(w)?.sourceTerm || '',
                );
                const language = result.language === 'other'
                  ? transliterationSourceLanguage === 'other'
                    ? 'other'
                    : transliterationSourceLanguage
                  : result.language === 'biblical_hebrew'
                    ? 'biblical_hebrew'
                    : result.language === 'koine_greek'
                      ? 'koine_greek'
                      : languageForTerm(w);
                lexiconEntries[w] = {
                  term: w,
                  pronunciation,
                  definition,
                  definitionOmitted,
                  language,
                  context: Array.isArray(scanned?.contexts) ? scanned.contexts[0] : undefined,
                  confidence: typeof result.confidence === 'number'
                    ? Math.max(0, Math.min(1, result.confidence))
                    : undefined,
                  needsReview: (result.needsReview === true && !definitionOmitted)
                    || unresolvedQualityTerms.has(w)
                    || (needsScholarDefinition && language !== 'other' && !definition),
                };
                updatedLexicon = true;
                acceptedWords.add(w);
              }
            }
          }
          if (updatedLexicon && activeProfile) {
            const partialLexicon: SmartAudioBookLexicon = {
              schemaVersion: 1,
              status: 'partial',
              definitionScanComplete: false,
              profileId: activeProfile.id,
              pronunciationModel: effectiveModel,
              scannedAt: Date.now(),
              entries: lexiconEntries,
            };
            await writeBookLexicon(userId, documentId, partialLexicon);
          }
          acceptedWords.forEach((word) => resolvedGeminiWords.add(word));
          if (acceptedWords.size === 0) {
            throw new Error('Gemini returned no Kokoro-compatible pronunciation choices for this batch.');
          }
          const omittedWords = chunk.filter((word: string) => !acceptedWords.has(word));
          if (omittedWords.length > 0) {
            serverLogger.warn(
              { event: 'pdf.scan.gemini.omitted_words', omittedWords, jobId, batch: i / chunkSize + 1 },
              `Gemini omitted ${omittedWords.length} terms from batch ${i / chunkSize + 1}`,
            );
          }

          // Persist each successful batch immediately. The job checkpoint and
          // the generated library now advance together, so a process restart
          // cannot discard all choices accumulated before the final save.
          if (batchUpdatedWords.size > 0) {
            const persistedWords = await mergeGeneratedGlobalPronunciations({
              generatedLibrary: globalDict,
              libraryAtScanStart: libraryAtBatchStart,
              updatedWords: batchUpdatedWords,
            });
            serverLogger.info({
              event: 'pdf.scan.global_pronunciations.batch_persisted',
              jobId,
              databaseProvider: process.env.POSTGRES_URL ? 'postgresql' : 'sqlite',
              batch: i / chunkSize + 1,
              requestedWords: batchUpdatedWords.size,
              persistedWords: persistedWords.length,
            }, 'Persisted generated global pronunciations for completed batch');
          }
          const batchDefinitions = Object.fromEntries(
            chunk
              .map((term: string) => [term, lexiconEntries[term]?.definition] as const)
              .filter(([, definition]) => Boolean(definition)),
          );
          if (Object.keys(batchDefinitions).length > 0) {
            const persistedDefinitions = await mergeGlobalDefinitions(batchDefinitions);
            serverLogger.info({
              event: 'pdf.scan.global_definitions.batch_persisted',
              jobId,
              batch: i / chunkSize + 1,
              persistedDefinitions: persistedDefinitions.length,
            }, 'Persisted generated global definitions for completed batch');
          }
          // Also persist Sefaria-sourced definitions for biblical words that
          // don't already have a definition stored in the global library.
          const sefariaDefinitions: Record<string, string> = {};
          for (const word of chunk) {
            const lex = lexiconEnrichments.get(word);
            if (lex && lex.definitions.length > 0 && !globalDefinitions[word] && !batchDefinitions[word]) {
              const primaryDef = lex.definitions[0];
              if (primaryDef && primaryDef.length > 2) {
                sefariaDefinitions[word] = primaryDef;
              }
            }
          }
          if (Object.keys(sefariaDefinitions).length > 0) {
            await mergeGlobalDefinitions(sefariaDefinitions);
            serverLogger.info({
              event: 'pdf.scan.sefaria_definitions.batch_persisted',
              jobId,
              batch: i / chunkSize + 1,
              count: Object.keys(sefariaDefinitions).length,
            }, 'Persisted Sefaria lexicon definitions for completed batch');
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown Gemini error';
          serverLogger.error({
            event: 'pdf.scan.gemini.batch.failed',
            error: message,
            httpStatus: err instanceof GeminiHttpError ? err.status : undefined,
            jobId,
            batch: i / chunkSize + 1,
          }, 'Gemini pronunciation batch failed');
          const errors = Array.isArray(jobState.errors) ? [...jobState.errors, `Gemini batch ${i / chunkSize + 1}: ${message}`] : [`Gemini batch ${i / chunkSize + 1}: ${message}`];
          
          const isTerminal = err instanceof GeminiHttpError && (err.status === 400 || err.status === 429 || err.status === 503);
          
          await saveJob({ 
            errors, 
            completed: isTerminal ? i : Math.min(i + chunk.length, wordsMissingOptions.length) 
          });

          if (isTerminal) {
            terminalGeminiError = message;
            break;
          }
        }
        await saveJob({
          completed: Math.min(i + chunk.length, wordsMissingOptions.length),
          resolved: resolvedGeminiWords.size,
          transliterationRejected: rejectedLatinTransliterations.size,
        });
      }
        }

    const generated = Object.keys(geminiRecommendations).length;
    const generatedDefinitions = Object.fromEntries(
      Object.entries(lexiconEntries)
        .filter(([, entry]) => Boolean(entry.definition) && entry.definitionOmitted !== true)
        .map(([term, entry]) => [term, entry.definition]),
    );
    await saveJob({
      stage: 'persisting',
      generated,
      generatedChoices: acceptedChoices,
      words: enrichWords(),
    });

    if (updatedGlobalWords.size > 0) {
      const persistedWords = await mergeGeneratedGlobalPronunciations({
        generatedLibrary: globalDict,
        libraryAtScanStart: globalDictAtScanStart,
        updatedWords: updatedGlobalWords,
      });
      serverLogger.info({
        event: 'pdf.scan.global_pronunciations.persisted',
        jobId,
        databaseProvider: process.env.POSTGRES_URL ? 'postgresql' : 'sqlite',
        requestedWords: updatedGlobalWords.size,
        persistedWords: persistedWords.length,
      }, 'Persisted generated global pronunciations');
    }
    if (Object.keys(generatedDefinitions).length > 0) {
      const persistedDefinitions = await mergeGlobalDefinitions(generatedDefinitions);
      serverLogger.info({
        event: 'pdf.scan.global_definitions.persisted',
        jobId,
        persistedDefinitions: persistedDefinitions.length,
      }, 'Persisted generated global definitions');
    }

    if (activeProfile) {
      const errors = Array.isArray(jobState.errors) ? jobState.errors : [];
      // "Complete" means every candidate in the full Scholar scope was
      // attempted without a batch-level failure. Individual Gemini omissions
      // remain reviewable, but cannot force the user into an endless rescan
      // loop; cleanup can still learn those pronunciations during generation.
      const definitionScanComplete = Boolean(
        needsScholarDefinition
        && errors.length === 0
        && !terminalGeminiError
        && isCompleteScholarScanScope({ mode, target, query }),
      );
      await writeBookLexicon(userId, documentId, {
        schemaVersion: 1,
        status: definitionScanComplete ? 'complete' : 'partial',
        definitionScanComplete,
        profileId: activeProfile.id,
        pronunciationModel: resolvePronunciationAiModel(activeProfile),
        scannedAt: Date.now(),
        entries: lexiconEntries,
      });
    }

    // Warm only Gemini's newly selected defaults up front. Existing library
    // alternatives are prepared lazily after the user first listens.
    const allPhoneticsToCache: { word: string; phonetic: string }[] = Object.entries(geminiRecommendations)
      .filter(([, phonetic]) => Boolean(phonetic))
      .map(([word, phonetic]) => ({ word, phonetic }));

    if (allPhoneticsToCache.length > 0) {
      try {
        const runtimeConfig = await getResolvedRuntimeConfig();
        const creds = await resolveTtsCredentials({
          providerHeader: null,
          apiKeyHeader: null,
          baseUrlHeader: null,
          fallbackProvider: runtimeConfig.defaultTtsProvider || 'custom-openai',
          restrictUserApiKeys: runtimeConfig.restrictUserApiKeys ?? false,
        });

        if (!('error' in creds)) {
          // Pre-cache in the background to avoid blocking the HTTP response and crashing the route
          (async () => {
            const batchSize = 10;
            for (let i = 0; i < allPhoneticsToCache.length; i += batchSize) {
              const batch = allPhoneticsToCache.slice(i, i + batchSize);
              const cachePromises = batch.map(({ word, phonetic }) => {
                const textToSynthesize = phonetic.startsWith('/') ? `[${word}](${phonetic})` : `[${word}](/${phonetic}/)`;
                return generateTTSBuffer({
                  text: textToSynthesize,
                  voice: 'af_heart',
                  speed: 1,
                  format: 'mp3',
                  provider: creds.provider,
                  apiKey: creds.apiKey,
                  baseUrl: creds.baseUrl,
                }).catch(e => console.error('Failed to pre-cache', word, e?.message || e));
              });
              await Promise.all(cachePromises);
            }
          })().catch(e => console.error('Background pre-caching error:', e));
        }
      } catch (e) {
        console.error('Error in pre-caching audio', e);
      }
    }

        const errors = Array.isArray(jobState.errors) ? jobState.errors : [];
        await saveJob({
          status: terminalGeminiError ? 'failed' : 'completed',
          completed: terminalGeminiError
            ? jobState.completed
            : wordsMissingOptions.length,
          generated,
          generatedChoices: acceptedChoices,
          resolved: resolvedGeminiWords.size,
          transliterationRejected: rejectedLatinTransliterations.size,
          error: terminalGeminiError
            || (errors.length > 0 ? `${errors.length} Gemini batch${errors.length === 1 ? '' : 'es'} failed. ${errors[0]}` : null),
          words: enrichWords(),
        });
      } catch (error) {
        if (error instanceof ScanCancelledError) {
          serverLogger.info({ event: 'pdf.scan.cancelled', jobId, documentId }, 'Foreign-word scan cancelled by user');
          return;
        }
        serverLogger.error({
          event: 'pdf.scan.pronunciations.failed',
          error: error instanceof Error ? error.message : String(error),
          jobId,
        }, 'Background foreign-word pronunciation generation failed');
        await saveJob({ status: 'failed', error: error instanceof Error ? error.message : 'Background pronunciation generation failed' }).catch(() => {});
      }
    });

    return NextResponse.json({ words: [], scanJobId: jobId, scanStatus: 'queued', scanTotal: 0 }, { status: 202 });
  } catch (error: any) {
    serverLogger.error({
      event: 'pdf.scan.failed',
      error: error instanceof Error ? error.message : String(error),
    }, 'Scan foreign words error');
    console.error('Scan foreign words error:', error);
    return NextResponse.json({ error: error?.message || 'Failed to scan document' }, { status: 500 });
  }
}
