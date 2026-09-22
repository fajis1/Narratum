import examples from './drama-director-examples.json';
import {
  DRAMA_AUDIO_TAG_ALLOWLIST, DRAMA_DELIVERY_STYLES, DRAMA_ENERGY,
  DRAMA_INTENSITY, DRAMA_PACING, DRAMA_PRIMARY_EMOTIONS,
  DRAMA_SECONDARY_EMOTIONS, DRAMA_SOCIAL_INTENTS, DRAMA_UTTERANCE_TYPES,
  DRAMA_PAUSE_TAGS,
} from '@/lib/shared/drama-director-schema';
import type { DramaDirectorSegment } from '@/lib/shared/drama-director-schema';
import type { DramaDirectorPolicy } from '@/lib/shared/drama-profile-settings';
import { fetchGeminiWithRateLimitFallback } from './gemini-failover';

const PROMPT_EXAMPLE_NUMBERS = new Set([1, 2, 3, 4, 5, 7, 8, 9, 11, 12, 15]);
const EVALUATION_EXAMPLE_NUMBERS = new Set([6, 10, 13, 14]);

export const DRAMA_DIRECTOR_PROMPT_EXAMPLES = examples.filter((example) => PROMPT_EXAMPLE_NUMBERS.has(example.number));
export const DRAMA_DIRECTOR_EVALUATION_EXAMPLES = examples.filter((example) => EVALUATION_EXAMPLE_NUMBERS.has(example.number));

export class DramaDirectorValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Drama Director output failed validation: ${issues.join('; ')}`);
    this.name = 'DramaDirectorValidationError';
  }
}

function applyPolicyToTags(
  tags: readonly string[],
  policy: DramaDirectorPolicy | undefined,
): DramaDirectorSegment['performance']['tags'] {
  if (!policy || policy.tags.usage === 'expressive') return tags.filter((tag): tag is DramaDirectorSegment['performance']['tags'][number] => DRAMA_AUDIO_TAG_ALLOWLIST.includes(tag as never));
  if (policy.tags.usage === 'off') return [];
  const pauseTags = new Set<string>(DRAMA_PAUSE_TAGS);
  const filtered = tags.filter((tag) => policy.tags.pauseStyle === 'cinematic' || !pauseTags.has(tag) || policy.tags.pauseStyle === 'natural' && tag !== 'long pause');
  const limit = policy.tags.usage === 'conservative' ? 1 : 2;
  return filtered.filter((tag): tag is DramaDirectorSegment['performance']['tags'][number] => DRAMA_AUDIO_TAG_ALLOWLIST.includes(tag as never)).slice(0, limit);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function inVocabulary(value: unknown, vocabulary: readonly string[]): value is string {
  return typeof value === 'string' && vocabulary.includes(value);
}

/** Segment text concatenation is byte-for-byte authoritative, including whitespace. */
export function validateDramaDirectorOutput(input: {
  sourceText: string;
  castNames: readonly string[];
  output: unknown;
  policy?: DramaDirectorPolicy;
}): DramaDirectorSegment[] {
  const issues: string[] = [];
  const source = record(input.output);
  const rawSegments = Array.isArray(input.output) ? input.output : source?.segments;
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    throw new DramaDirectorValidationError(['Expected a non-empty segments array.']);
  }
  const cast = new Set(input.castNames);
  const tagSet = new Set<string>(DRAMA_AUDIO_TAG_ALLOWLIST);
  const segments: DramaDirectorSegment[] = [];
  for (const [index, raw] of rawSegments.entries()) {
    const issueCount = issues.length;
    const segment = record(raw);
    const performance = record(segment?.performance);
    const label = `Segment ${index + 1}`;
    if (!segment || !performance) {
      issues.push(`${label}: missing segment or performance object.`);
      continue;
    }
    if (typeof segment.speaker !== 'string' || !cast.has(segment.speaker)) issues.push(`${label}: speaker is not in the cast.`);
    if (!inVocabulary(segment.utteranceType, DRAMA_UTTERANCE_TYPES)) issues.push(`${label}: invalid utteranceType.`);
    if (typeof segment.text !== 'string' || segment.text.length === 0) issues.push(`${label}: text must be non-empty.`);
    if (typeof segment.sceneContext !== 'string' || !segment.sceneContext.trim()) issues.push(`${label}: sceneContext is required.`);
    if (typeof segment.omit_from_audio !== 'boolean') issues.push(`${label}: omit_from_audio must be a boolean.`);
    if (!inVocabulary(performance.primaryEmotion, DRAMA_PRIMARY_EMOTIONS)) issues.push(`${label}: invalid primaryEmotion.`);
    if (!Array.isArray(performance.secondaryEmotions) || performance.secondaryEmotions.some((v) => !inVocabulary(v, DRAMA_SECONDARY_EMOTIONS))) issues.push(`${label}: invalid secondaryEmotions.`);
    if (!inVocabulary(performance.socialIntent, DRAMA_SOCIAL_INTENTS)) issues.push(`${label}: invalid socialIntent.`);
    if (!Array.isArray(performance.delivery) || performance.delivery.some((v) => !inVocabulary(v, DRAMA_DELIVERY_STYLES))) issues.push(`${label}: invalid delivery.`);
    if (!inVocabulary(performance.pace, DRAMA_PACING)) issues.push(`${label}: invalid pace.`);
    if (!inVocabulary(performance.energy, DRAMA_ENERGY)) issues.push(`${label}: invalid energy.`);
    if (!inVocabulary(performance.intensity, DRAMA_INTENSITY)) issues.push(`${label}: invalid intensity.`);
    if (!Array.isArray(performance.tags)) issues.push(`${label}: tags must be an array.`);
    if (performance.nuance !== undefined && typeof performance.nuance !== 'string') issues.push(`${label}: nuance must be a string.`);
    if (issues.length > issueCount) continue;
    segments.push({
      speaker: segment.speaker as string,
      utteranceType: segment.utteranceType as DramaDirectorSegment['utteranceType'],
      text: segment.text as string,
      sceneContext: segment.sceneContext as string,
      omit_from_audio: segment.omit_from_audio as boolean,
      performance: {
        primaryEmotion: performance.primaryEmotion as DramaDirectorSegment['performance']['primaryEmotion'],
        secondaryEmotions: performance.secondaryEmotions as DramaDirectorSegment['performance']['secondaryEmotions'],
        socialIntent: performance.socialIntent as DramaDirectorSegment['performance']['socialIntent'],
        delivery: performance.delivery as DramaDirectorSegment['performance']['delivery'],
        pace: performance.pace as DramaDirectorSegment['performance']['pace'],
        energy: performance.energy as DramaDirectorSegment['performance']['energy'],
        intensity: performance.intensity as DramaDirectorSegment['performance']['intensity'],
        tags: applyPolicyToTags(
          (performance.tags as unknown[]).filter((tag): tag is string => typeof tag === 'string' && tagSet.has(tag)),
          input.policy,
        ),
        ...(typeof performance.nuance === 'string' ? { nuance: performance.nuance } : {}),
      },
    });
  }
  if (rawSegments.map((segment) => record(segment)?.text).some((text) => typeof text !== 'string') ||
      rawSegments.map((segment) => record(segment)?.text).join('') !== input.sourceText) {
    issues.push('Segment text does not exactly match the authoritative source.');
  }
  if (issues.length) throw new DramaDirectorValidationError(issues);
  return segments;
}

export function buildDramaDirectorPrompt(input: { sourceText: string; castNames: readonly string[]; policy?: DramaDirectorPolicy }): string {
  return [
    'You are the OpenReader Drama Director. Return JSON only: {"segments": [...]} .',
    'Partition the entire source text into ordered, contiguous segments. The concatenation of every segment.text must equal the source exactly, including spaces, punctuation, and newlines. Never rewrite, add, omit, or normalize spoken text.',
    'Use only cast names supplied below for speaker. Never choose or emit a voiceId.',
    'Formatting is evidence, not proof of utterance type. Internal thought and squad-link may both be italicized; use narrative context. Squad-link uses the character’s natural voice, never an automatic whisper.',
    'Authority is not loudness. High intensity can be quiet and low energy. Performance can change within a thought; split at the exact source boundary when needed. Default to tags: []; use tags only for localized effects.',
    `utteranceType: ${JSON.stringify(DRAMA_UTTERANCE_TYPES)}`,
    `primaryEmotion/secondaryEmotions: ${JSON.stringify(DRAMA_PRIMARY_EMOTIONS)}`,
    `socialIntent: ${JSON.stringify(DRAMA_SOCIAL_INTENTS)}`,
    `delivery: ${JSON.stringify(DRAMA_DELIVERY_STYLES)}`,
    `pace: ${JSON.stringify(DRAMA_PACING)}; energy: ${JSON.stringify(DRAMA_ENERGY)}; intensity: ${JSON.stringify(DRAMA_INTENSITY)}`,
    `Allowed tags only: ${JSON.stringify(DRAMA_AUDIO_TAG_ALLOWLIST)}. Do not put markup into text.`,
    'Every segment needs speaker, utteranceType, text, sceneContext (1–3 sentences), performance with all required fields, and omit_from_audio (boolean). Keep all text in the segment list even when omit_from_audio is true.',
    'Author examples (text is exact; direction illustrates context and performance):',
    ...(input.policy ? [
      `Director policy: ${JSON.stringify(input.policy)}. Apply this as a bias only; preserve scene-appropriate intensity and exact source text.`,
      'Narrator expressiveness applies to narration; character expressiveness applies to character speech. Persistent character direction remains authoritative for identity.',
    ] : []),
    ...DRAMA_DIRECTOR_PROMPT_EXAMPLES.map((example) => JSON.stringify(example)),
    `Cast names: ${JSON.stringify(input.castNames)}`,
    `Authoritative source text: ${JSON.stringify(input.sourceText)}`,
  ].join('\n');
}

/** One bounded correction request. The caller supplies its Gemini transport. */
export async function directDramaWithRepair(input: {
  sourceText: string;
  castNames: readonly string[];
  generate: (prompt: string) => Promise<unknown>;
  policy?: DramaDirectorPolicy;
}): Promise<DramaDirectorSegment[]> {
  const prompt = buildDramaDirectorPrompt(input);
  let output: unknown;
  try {
    output = await input.generate(prompt);
    return validateDramaDirectorOutput({ ...input, output });
  } catch (error) {
    if (!(error instanceof DramaDirectorValidationError)) throw error;
    const repairPrompt = [
      prompt,
      'Your previous JSON failed validation. Correct it once. Return the full corrected JSON object only.',
      `Validation issues: ${JSON.stringify(error.issues)}`,
      `Previous output: ${JSON.stringify(output)}`,
    ].join('\n');
    output = await input.generate(repairPrompt);
    return validateDramaDirectorOutput({ ...input, output });
  }
}

/** Gemini JSON transport for the Director; orchestration supplies profile credentials. */
export async function directDramaWithGemini(input: {
  sourceText: string;
  castNames: readonly string[];
  apiKey: string;
  backupApiKey?: string;
  model: string;
  policy?: DramaDirectorPolicy;
}): Promise<DramaDirectorSegment[]> {
  return directDramaWithRepair({
    ...input,
    generate: async (prompt) => {
      const { response } = await fetchGeminiWithRateLimitFallback({
        primaryApiKey: input.apiKey,
        backupApiKey: input.backupApiKey,
        requestedModel: input.model,
        request: (apiKey, model) => fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || input.model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
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
      if (!response.ok) throw new Error(`Gemini Drama Director request failed (HTTP ${response.status}).`);
      const data = await response.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const jsonText = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
      if (!jsonText) throw new DramaDirectorValidationError(['Gemini returned no Director JSON.']);
      try {
        return JSON.parse(jsonText) as unknown;
      } catch {
        throw new DramaDirectorValidationError(['Gemini returned invalid Director JSON.']);
      }
    },
  });
}
