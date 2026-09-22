import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { readSmartAudioProfilesDocument, findSmartAudioProfileById } from '@/lib/server/smart-audio-profiles';
import { db } from '@/db';
import { adminSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { generateTTSBuffer } from '@/lib/server/tts/generate';
import { resolveTtsCredentials } from '@/lib/server/admin/resolve-credentials';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { buildKokoroPronunciationInstructions, isKokoroCompatiblePronunciation } from '@/lib/shared/kokoro-pronunciation-policy';
import {
  resolvePronunciationAiModel,
  resolvePronunciationAiModels,
} from '@/lib/shared/smart-audio-models';
import { fetchGeminiWithRateLimitFallback } from '@/lib/server/smart-audio/gemini-failover';

const SEED_EXAMPLES = [
  "Make the ending sound more like -een instead of -ayn",
  "Soften the initial consonant transition and lengthen the final vowel",
  "Ensure the middle diphthong sounds like 'oy' in boy without a hard g sound",
  "Make the 'ch' sound a hard K sound like in choir",
  "Drop the double-N repetition so it flows smoothly into the next syllable"
];

async function getFeedbackExamples() {
  const rows = await db.select().from(adminSettings).where(eq(adminSettings.key, 'pronunciation_feedback_examples')).limit(1);
  if (rows.length > 0 && rows[0].valueJson) {
    try {
      const parsed = typeof rows[0].valueJson === 'string' ? JSON.parse(rows[0].valueJson) : rows[0].valueJson;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) {}
  }
  // Initialize if empty
  await db.insert(adminSettings).values({
    key: 'pronunciation_feedback_examples',
    valueJson: JSON.stringify(SEED_EXAMPLES)
  }).onConflictDoUpdate({
    target: adminSettings.key,
    set: { valueJson: JSON.stringify(SEED_EXAMPLES) }
  });
  return SEED_EXAMPLES;
}

export async function GET(req: NextRequest) {
  try {
    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    const profilesDoc = await readSmartAudioProfilesDocument(ctxOrRes.userId);
    const activeProfile = findSmartAudioProfileById(profilesDoc, profilesDoc.selectedProfileId);
    const primaryKey = (activeProfile?.geminiApiKey || '').trim();
    const apiKeyLast4 = primaryKey.length >= 4 ? `...${primaryKey.slice(-4)}` : primaryKey ? 'Configured' : null;
    const backupKey = (activeProfile?.backupGeminiApiKey || '').trim();
    const backupApiKeyLast4 = backupKey.length >= 4 ? `...${backupKey.slice(-4)}` : backupKey ? 'Configured' : null;

    const examples = await getFeedbackExamples();
    return NextResponse.json({
      feedbackExamples: examples,
      pronunciationModel: resolvePronunciationAiModel(activeProfile),
      pronunciationModelFallbacks: resolvePronunciationAiModels(activeProfile).slice(1),
      apiKeyLast4,
      backupApiKeyLast4,
      profileName: activeProfile?.name || null,
    });
  } catch (error: any) {
    console.error('Refine pronunciations GET error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    const userId = ctxOrRes.userId;

    const body = await req.json();
    const { word, feedback, currentChoices } = body;
    const useBackupKey = body.useBackupKey === true;
    if (!word || !feedback) {
      return NextResponse.json({ error: 'Missing word or feedback' }, { status: 400 });
    }

    // 1. Append feedback to global examples
    let examples = await getFeedbackExamples();
    // Add to front, take top 5
    examples = [feedback, ...examples.filter((e: string) => e !== feedback)].slice(0, 5);
    await db.update(adminSettings)
      .set({ valueJson: JSON.stringify(examples) })
      .where(eq(adminSettings.key, 'pronunciation_feedback_examples'));

    // 2. Resolve Gemini model and keys (Primary & Backup)
    const profilesDoc = await readSmartAudioProfilesDocument(userId);
    const activeProfile = findSmartAudioProfileById(profilesDoc, profilesDoc.selectedProfileId);
    
    // Look up system fallback keys in adminSettings if profile backup key is empty
    let primaryKey = (activeProfile?.geminiApiKey || '').trim();
    let backupKey = (activeProfile?.backupGeminiApiKey || '').trim();

    const backupRow = await db.select().from(adminSettings).where(eq(adminSettings.key, 'backupGeminiApiKey')).limit(1);
    if (!backupKey && backupRow.length > 0 && backupRow[0].valueJson) {
      try { backupKey = JSON.parse(backupRow[0].valueJson); } catch (e) { backupKey = backupRow[0].valueJson; }
    }

    if (!primaryKey) {
      const primaryRow = await db.select().from(adminSettings).where(eq(adminSettings.key, 'geminiApiKey')).limit(1);
      if (primaryRow.length > 0 && primaryRow[0].valueJson) {
        try { primaryKey = JSON.parse(primaryRow[0].valueJson); } catch (e) { primaryKey = primaryRow[0].valueJson; }
      }
    }

    if (!primaryKey && !(useBackupKey && backupKey)) {
      return NextResponse.json({ error: 'Gemini API key not configured. Please enter your API key in Smart Audio Settings.', canUseBackupKey: Boolean(backupKey) }, { status: 400 });
    }

    const model = (typeof body.model === 'string' && body.model.trim()) || resolvePronunciationAiModel(activeProfile);
    const configuredFallbacks = Array.isArray(body.fallbackModels)
      ? body.fallbackModels.filter((m: unknown): m is string => typeof m === 'string' && Boolean(m.trim()))
      : resolvePronunciationAiModels(activeProfile).slice(1);
    // 3. Call Gemini with automatic key failover
    const prompt = `${buildKokoroPronunciationInstructions(activeProfile)}

The user wants to adjust the Kokoro IPA pronunciation for the word '${word}'.
User Feedback: '${feedback}'.
DO NOT generate any of the following previous choices: ${JSON.stringify(currentChoices || [])}.
Generate 5 NEW distinct, plausible Kokoro IPA pronunciation variations that address the user's feedback.
Return a JSON object: { "newChoices": ["/pron1/", "/pron2/", "/pron3/", "/pron4/", "/pron5/"] }`;

    const firstKey = useBackupKey && backupKey ? backupKey : primaryKey;
    const secondKey = firstKey === backupKey ? primaryKey : backupKey;
    const { response: res, usedModel } = await fetchGeminiWithRateLimitFallback({
      primaryApiKey: firstKey,
      backupApiKey: secondKey,
      requestedModel: model,
      fallbackModels: configuredFallbacks.length > 0 ? configuredFallbacks : undefined,
      request: (apiKey, requestModel) => fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(requestModel || model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        },
      ),
    });
    const errText = res.ok ? '' : await res.clone().text();

    if (!res || !res.ok) {
      console.error('Gemini API returned final error status:', res?.status, errText);
      let errorMessage = 'Failed to generate choices from Gemini API';
      try {
        const errJson = JSON.parse(errText);
        if (errJson.error && errJson.error.message) {
          errorMessage = errJson.error.message;
        }
      } catch (e) {}

      if (res?.status === 429 || errorMessage.toLowerCase().includes('quota') || errorMessage.toLowerCase().includes('rate')) {
        return NextResponse.json({
          error: `Gemini API Quota/Rate Limit Exceeded (429): Free/Paid tier limit reached. Please wait a minute or check billing. ${errorMessage}`,
          retryAfter: 60,
          canUseBackupKey: Boolean(backupKey),
        }, { status: 429 });
      }

      if (res?.status === 503 || errorMessage.toLowerCase().includes('overloaded') || errorMessage.toLowerCase().includes('unavailable')) {
        return NextResponse.json({
          error: `Gemini AI Server Overloaded (503): Google Gemini servers are experiencing temporary high load. Please try again in a few seconds. ${errorMessage}`,
          retryAfter: 10,
          canUseBackupKey: Boolean(backupKey),
        }, { status: 503 });
      }

      return NextResponse.json({ error: errorMessage, canUseBackupKey: Boolean(backupKey) }, { status: res?.status || 500 });
    }

    const data = await res.json();
    let newChoices: string[] = [];
    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
      try {
        const generated = JSON.parse(data.candidates[0].content.parts[0].text);
        newChoices = Array.isArray(generated.newChoices)
          ? generated.newChoices.filter(isKokoroCompatiblePronunciation).slice(0, 5)
          : [];
      } catch (e) {
        console.error('Failed to parse Gemini response:', e);
      }
    }

    if (!newChoices || newChoices.length === 0) {
      return NextResponse.json({ error: 'Failed to generate new choices' }, { status: 500 });
    }

    // 4. Pre-cache Kokoro Audio buffers
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
        const cachePromises = newChoices.map((phonetic) => {
          const textToSynthesize = phonetic.startsWith('/') ? `[${word}](${phonetic})` : `[${word}](/${phonetic}/)`;
          return generateTTSBuffer({
            text: textToSynthesize,
            voice: 'af_heart', // Defaulting to af_heart as used in pre-caching elsewhere
            speed: 1,
            format: 'mp3',
            provider: creds.provider,
            apiKey: creds.apiKey,
            baseUrl: creds.baseUrl,
          }).catch(e => console.error('Failed to pre-cache refined', word, phonetic, e));
        });
        await Promise.all(cachePromises);
      }
    } catch (e) {
      console.error('Error in pre-caching refined audio', e);
    }

    return NextResponse.json({
      newChoices,
      feedbackExamples: examples,
      pronunciationModel: usedModel || model,
    });
  } catch (error: any) {
    console.error('Refine pronunciations POST error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
