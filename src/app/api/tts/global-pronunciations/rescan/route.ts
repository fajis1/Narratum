import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { adminSettings } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import {
  findSmartAudioProfileById,
  mergeGeneratedPronunciationsIntoLatestProfile,
  readSmartAudioProfilesDocument,
} from '@/lib/server/smart-audio-profiles';
import {
  buildKokoroPronunciationInstructions,
  getKokoroPronunciationQualityWarnings,
  isKokoroCompatiblePronunciation,
  normalizeKokoroPronunciationCandidate,
} from '@/lib/shared/kokoro-pronunciation-policy';

import { resolvePronunciationAiModel } from '@/lib/shared/smart-audio-models';
import { errorResponse } from '@/lib/server/errors/next-response';
import { serverLogger } from '@/lib/server/logger';
import { fetchGeminiWithRateLimitFallback } from '@/lib/server/smart-audio/gemini-failover';

type StoredChoice = {
  phonetic: string;
  usageCount?: number;
  isUserCustom?: boolean;
  timestamp?: number;
};

function normalizeGlobalLibrary(value: unknown): Record<string, StoredChoice[]> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object') return {};
  const normalized: Record<string, StoredChoice[]> = {};
  for (const [word, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const choices = Array.isArray(raw) ? raw : [raw];
    normalized[word] = choices.flatMap((choice) => {
      if (typeof choice === 'string') return [{ phonetic: choice, usageCount: 0 }];
      if (!choice || typeof choice !== 'object') return [];
      const record = choice as Record<string, unknown>;
      return typeof record.phonetic === 'string'
        ? [{ ...record, phonetic: record.phonetic } as StoredChoice]
        : [];
    }).slice(0, 5);
  }
  return normalized;
}

function normalizeGeneratedPronunciation(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const wrapped = trimmed.startsWith('/') && trimmed.endsWith('/')
    ? trimmed
    : `/${trimmed.replace(/^\/|\/$/g, '')}/`;
  return normalizeKokoroPronunciationCandidate('', wrapped);
}



type SuspectPronunciation = {
  word: string;
  pronunciation: string;
  warnings: string[];
};

export async function GET(req: NextRequest) {
  try {
    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const rows = await db
      .select({ valueJson: adminSettings.valueJson })
      .from(adminSettings)
      .where(eq(adminSettings.key, 'global_pronunciations'))
      .limit(1);
    const library = normalizeGlobalLibrary(rows[0]?.valueJson || {});
    const profiles = await readSmartAudioProfilesDocument(ctxOrRes.userId);
    const profile = findSmartAudioProfileById(profiles, profiles.selectedProfileId);

    const globalSuspects: SuspectPronunciation[] = Object.entries(library).flatMap(
      ([word, choices]) => choices.flatMap(({ phonetic }) => {
        const warnings = getKokoroPronunciationQualityWarnings(word, phonetic);
        return warnings.length > 0 ? [{ word, pronunciation: phonetic, warnings }] : [];
      }),
    );
    const personalSuspects: SuspectPronunciation[] = Object.entries(profile?.pronunciations || {}).flatMap(
      ([word, pronunciation]) => {
        const warnings = getKokoroPronunciationQualityWarnings(word, pronunciation);
        return warnings.length > 0 ? [{ word, pronunciation, warnings }] : [];
      },
    );

    return NextResponse.json({
      globalSuspects,
      personalSuspects,
      globalWords: [...new Set(globalSuspects.map(({ word }) => word))],
      personalWords: [...new Set(personalSuspects.map(({ word }) => word))],
      profileName: profile?.name || 'Selected profile',
    });
  } catch (error) {
    return errorResponse(error, {
      logger: serverLogger,
      event: 'tts.global_pronunciations.audit.failed',
      msg: 'Failed to scan saved pronunciation libraries',
      apiErrorMessage: 'Failed to scan saved pronunciation libraries.',
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const requestedGlobalWords: string[] = Array.isArray(body.globalWords)
      ? body.globalWords.filter((word: unknown): word is string => typeof word === 'string' && Boolean(word.trim()))
      : Array.isArray(body.words) && !Array.isArray(body.personalWords)
        ? body.words.filter((word: unknown): word is string => typeof word === 'string' && Boolean(word.trim()))
        : [];
    const rawRequestedPersonalWords: string[] = Array.isArray(body.personalWords)
      ? body.personalWords.filter((word: unknown): word is string => typeof word === 'string' && Boolean(word.trim()))
      : Array.isArray(body.words) && !Array.isArray(body.globalWords)
        ? body.words.filter((word: unknown): word is string => typeof word === 'string' && Boolean(word.trim()))
        : [];
    const globalWords = [...new Set(requestedGlobalWords.map((word) => word.trim()))];
    let personalWords = [...new Set(rawRequestedPersonalWords.map((word) => word.trim()))];
    const words = [...new Set([...globalWords, ...personalWords])];
    if (words.length === 0) {
      return NextResponse.json({ error: 'Select at least one suspect pronunciation.' }, { status: 400 });
    }

    const rows = await db
      .select({ valueJson: adminSettings.valueJson })
      .from(adminSettings)
      .where(eq(adminSettings.key, 'global_pronunciations'))
      .limit(1);
    const library = normalizeGlobalLibrary(rows[0]?.valueJson || {});
    const profiles = await readSmartAudioProfilesDocument(ctxOrRes.userId);
    const profile = findSmartAudioProfileById(profiles, profiles.selectedProfileId);
    const apiKey = (profile?.geminiApiKey || '').trim();
    if (!apiKey) {
      return NextResponse.json({
        error: 'Configure the primary Gemini key in the selected Smart Audio profile before rescanning.',
      }, { status: 400 });
    }
    const model = resolvePronunciationAiModel(profile);
    const personalLibrary = profile?.pronunciations || {};
    const candidates = words
      .filter((word) => library[word] || personalLibrary[word])
      .map((word) => ({
        word,
        sources: [
          ...(globalWords.includes(word) && library[word] ? ['global'] : []),
          ...(personalWords.includes(word) && personalLibrary[word] ? ['personal'] : []),
        ],
        rejectedChoices: [
          ...(library[word] || []).map((choice) => choice.phonetic),
          ...(personalLibrary[word] ? [personalLibrary[word]] : []),
        ].map((pronunciation) => ({
          pronunciation,
          warnings: getKokoroPronunciationQualityWarnings(word, pronunciation),
        })),
      }));
    if (candidates.length === 0) {
      return NextResponse.json({ error: 'None of the selected words remain in the global or personal library.' }, { status: 400 });
    }

    const generated: Record<string, unknown> = {};
    const pronunciationInstructions = buildKokoroPronunciationInstructions(profile);
    const batchSize = 20;
    for (let offset = 0; offset < candidates.length; offset += batchSize) {
      const candidateBatch = candidates.slice(offset, offset + batchSize);
      const prompt = `${pronunciationInstructions}

Replace the suspect Kokoro pronunciations below.
Generate five new choices per exact word, best choice first.
Keep every choice within the profile's selected pronunciation tradition. Do not mix Erasmian, historical, modern, or reconstructed systems merely to make the choices different.
Do not repeat any rejected choice. Avoid adjacent /y/ and /j/ sequences that Kokoro may spell aloud.
Return JSON only as {"word":["/best/","/choice2/","/choice3/","/choice4/","/choice5/"]}.

Suspect entries:
${JSON.stringify(candidateBatch)}`;
      const { response } = await fetchGeminiWithRateLimitFallback({
        primaryApiKey: apiKey,
        backupApiKey: profile?.backupGeminiApiKey,
        requestedModel: model,
        request: (requestApiKey, requestModel) => fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(requestModel || model)}:generateContent?key=${encodeURIComponent(requestApiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: 'application/json' },
            }),
          },
        ),
      });
      if (!response.ok) {
        return NextResponse.json({
          error: `Gemini pronunciation rescan failed (HTTP ${response.status}).`,
          retryAfter: response.status === 429 ? 60 : undefined,
        }, { status: response.status });
      }
      const data = await response.json();
      const generatedText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!generatedText) {
        return NextResponse.json({ error: 'Gemini returned no replacement pronunciations.' }, { status: 502 });
      }
      const generatedBatch = JSON.parse(generatedText) as Record<string, unknown>;
      for (const { word } of candidateBatch) {
        if (Object.hasOwn(generatedBatch, word)) {
          generated[word] = generatedBatch[word];
        }
      }
    }

    const replacements: Record<string, StoredChoice[]> = {};
    const now = Date.now();
    for (const word of words) {
      const rawChoices = generated[word];
      if (!Array.isArray(rawChoices)) continue;
      const rejectedChoices = new Set([
        ...(library[word] || []).map((choice) => choice.phonetic),
        ...(personalLibrary[word] ? [personalLibrary[word]] : []),
      ].filter((choice) => (
        typeof choice === 'string' && getKokoroPronunciationQualityWarnings(word, choice).length === 0
      )));
      const choices = rawChoices
        .map(normalizeGeneratedPronunciation)
        .filter((choice): choice is string => (
          choice !== null
          && !rejectedChoices.has(choice)
          && getKokoroPronunciationQualityWarnings(word, choice).length === 0
        ))
        .filter((choice, index, all) => all.indexOf(choice) === index)
        .slice(0, 5);
      if (choices.length === 0) continue;
      replacements[word] = choices.map((phonetic) => ({
        phonetic,
        usageCount: 0,
        isUserCustom: false,
        timestamp: now,
      }));
    }

    // Legacy global entries were often stored without slash wrappers. If Gemini
    // does not return a usable replacement for one of those entries, still make
    // the safe, deterministic format repair instead of leaving it unchanged.
    for (const word of words) {
      if (replacements[word]) continue;
      const fallbackChoices = [
        ...(library[word] || []).map((choice) => choice.phonetic),
        ...(personalLibrary[word] ? [personalLibrary[word]] : []),
      ]
        .map(normalizeGeneratedPronunciation)
        .filter((choice): choice is string => (
          choice !== null
          && getKokoroPronunciationQualityWarnings(word, choice).length === 0
        ))
        .filter((choice, index, all) => all.indexOf(choice) === index)
        .slice(0, 5);
      if (fallbackChoices.length > 0) {
        replacements[word] = fallbackChoices.map((phonetic) => ({
          phonetic,
          usageCount: 0,
          isUserCustom: false,
          timestamp: Date.now(),
        }));
      }
    }

    if (Object.keys(replacements).length === 0) {
      return NextResponse.json({
        error: 'Gemini did not return any replacement choices that passed the Kokoro safety checks.',
      }, { status: 502 });
    }

    const globalReplacementCandidates = globalWords.filter((word) => replacements[word]);
    let replacedGlobal: string[] = [];
    if (globalReplacementCandidates.length > 0) {
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
          const latestLibrary = normalizeGlobalLibrary(latestRows[0]?.valueJson || {});
          replacedGlobal = globalReplacementCandidates.filter((word) => (
            JSON.stringify(latestLibrary[word] || []) === JSON.stringify(library[word] || [])
          ));
          for (const word of replacedGlobal) latestLibrary[word] = replacements[word];
          await tx.insert(adminSettings).values({
            key: 'global_pronunciations',
            valueJson: JSON.stringify(latestLibrary),
          }).onConflictDoUpdate({
            target: adminSettings.key,
            set: { valueJson: JSON.stringify(latestLibrary) },
          });
        });
      } else {
        // better-sqlite3 transactions require a synchronous callback.
        db.transaction((tx: typeof db) => {
          const latestRows = tx
            .select({ valueJson: adminSettings.valueJson })
            .from(adminSettings)
            .where(eq(adminSettings.key, 'global_pronunciations'))
            .limit(1)
            .all();
          const latestLibrary = normalizeGlobalLibrary(latestRows[0]?.valueJson || {});
          replacedGlobal = globalReplacementCandidates.filter((word) => (
            JSON.stringify(latestLibrary[word] || []) === JSON.stringify(library[word] || [])
          ));
          for (const word of replacedGlobal) latestLibrary[word] = replacements[word];
          tx.insert(adminSettings).values({
            key: 'global_pronunciations',
            valueJson: JSON.stringify(latestLibrary),
          }).onConflictDoUpdate({
            target: adminSettings.key,
            set: { valueJson: JSON.stringify(latestLibrary) },
          }).run();
        });
      }
    }

    const personalReplacementCandidates = personalWords.filter((word) => replacements[word]);
    let replacedPersonal: string[] = [];
    if (personalReplacementCandidates.length > 0 && profile) {
      const merged = await mergeGeneratedPronunciationsIntoLatestProfile(
        ctxOrRes.userId,
        profile.id,
        Object.fromEntries(
          personalReplacementCandidates.map((word) => [word, replacements[word][0].phonetic]),
        ),
        personalLibrary,
      );
      replacedPersonal = merged?.appliedWords || [];
    }

    const replaced = [...new Set([...replacedGlobal, ...replacedPersonal])];
    return NextResponse.json({
      replaced,
      replacedGlobal,
      replacedPersonal,
      model,
    });
  } catch (error) {
    return errorResponse(error, {
      logger: serverLogger,
      event: 'tts.global_pronunciations.rescan.failed',
      msg: 'Failed to rescan suspect global pronunciations',
      apiErrorMessage: 'Failed to rescan suspect global pronunciations.',
    });
  }
}
