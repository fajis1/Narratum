import { assertDramaSourceSpans, batchDramaSourceSpans, createDramaSourceSpans, type DramaSourceSpan } from './drama-source-spans';
import { serverLogger } from '@/lib/server/logger';
import examples from './drama-director-examples.json';
import {
  DRAMA_DELIVERY_STYLES, DRAMA_ENERGY, DRAMA_INLINE_PAUSE_EVENT_SET, DRAMA_INLINE_VOCAL_EVENTS,
  DRAMA_INTENSITY, DRAMA_PACING, DRAMA_PRIMARY_EMOTIONS,
  DRAMA_SECONDARY_EMOTIONS, DRAMA_SOCIAL_INTENTS, DRAMA_UTTERANCE_TYPES,
} from '@/lib/shared/drama-director-schema';
import type { DramaDirectorSegment } from '@/lib/shared/drama-director-schema';
import type { DramaDirectorPolicy } from '@/lib/shared/drama-profile-settings';
import { fetchGeminiWithRateLimitFallback } from './gemini-failover';
import { geminiPrivateErrorDetails } from './gemini-error-details';

const PROMPT_EXAMPLE_NUMBERS = new Set([1, 2, 3, 4, 5, 7, 8, 9, 11, 12, 15]);
const EVALUATION_EXAMPLE_NUMBERS = new Set([6, 10, 13, 14]);

export const DRAMA_DIRECTOR_PROMPT_EXAMPLES = examples.filter((example) => PROMPT_EXAMPLE_NUMBERS.has(example.number));
export const DRAMA_DIRECTOR_EVALUATION_EXAMPLES = examples.filter((example) => EVALUATION_EXAMPLE_NUMBERS.has(example.number));

export class DramaDirectorValidationError extends Error {
  constructor(public readonly issues: string[], public readonly response?: string, public readonly diagnostics?: Record<string, unknown>) {
    super(`Drama Director output failed validation: ${issues.join('; ')}`);
    this.name = 'DramaDirectorValidationError';
  }
}

export interface DramaDirectorResponseAttempt {
  attempt: number;
  issues: string[];
  response: string;
  diagnostics?: Record<string, unknown>;
}

function applyPolicyToTags(
  tags: readonly string[],
  policy: DramaDirectorPolicy | undefined,
): DramaDirectorSegment['performance']['tags'] {
  if (!policy || policy.tags.usage === 'expressive') return tags.filter((tag): tag is DramaDirectorSegment['performance']['tags'][number] => DRAMA_INLINE_VOCAL_EVENTS.includes(tag as never));
  if (policy.tags.usage === 'off') return [];
  const pauseTags = DRAMA_INLINE_PAUSE_EVENT_SET;
  const filtered = tags.filter((tag) => policy.tags.pauseStyle === 'cinematic' || !pauseTags.has(tag) || policy.tags.pauseStyle === 'natural' && tag !== 'long pause');
  const limit = policy.tags.usage === 'conservative' ? 1 : 2;
  return filtered.filter((tag): tag is DramaDirectorSegment['performance']['tags'][number] => DRAMA_INLINE_VOCAL_EVENTS.includes(tag as never)).slice(0, limit);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function inVocabulary(value: unknown, vocabulary: readonly string[]): value is string {
  return typeof value === 'string' && vocabulary.includes(value);
}

/** Server validation remains authoritative, including exact legacy text validation. */
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
  const tagSet = new Set<string>(DRAMA_INLINE_VOCAL_EVENTS);
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
    // Source cleanup has already decided what is narratable. The Director cannot omit more text.
    if (segment.omit_from_audio !== false) issues.push(`${label}: omit_from_audio must be false for cleaned source text.`);
    if ('voiceId' in segment) issues.push(`${label}: voiceId must come from the reviewed cast.`);
    if (!inVocabulary(performance.primaryEmotion, DRAMA_PRIMARY_EMOTIONS)) issues.push(`${label}: invalid primaryEmotion.`);
    const secondaryEmotions = performance.secondaryEmotions;
    if (!Array.isArray(secondaryEmotions) || secondaryEmotions.length > 2 || secondaryEmotions.some((value) => !inVocabulary(value, DRAMA_SECONDARY_EMOTIONS))) issues.push(`${label}: secondaryEmotions must contain 0–2 allowed values.`);
    if (!inVocabulary(performance.socialIntent, DRAMA_SOCIAL_INTENTS)) issues.push(`${label}: invalid socialIntent.`);
    if (!Array.isArray(performance.delivery) || performance.delivery.length < 1 || performance.delivery.length > 2 || performance.delivery.some((v) => !inVocabulary(v, DRAMA_DELIVERY_STYLES))) issues.push(`${label}: delivery must contain 1–2 allowed values.`);
    if (!inVocabulary(performance.pace, DRAMA_PACING)) issues.push(`${label}: invalid pace.`);
    if (!inVocabulary(performance.energy, DRAMA_ENERGY)) issues.push(`${label}: invalid energy.`);
    if (!inVocabulary(performance.intensity, DRAMA_INTENSITY)) issues.push(`${label}: invalid intensity.`);
    if (!Array.isArray(performance.tags) || performance.tags.length > 2 || performance.tags.some((tag) => !tagSet.has(tag))) issues.push(`${label}: tags must contain 0–2 allowed values.`);
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
        secondaryEmotions: secondaryEmotions as DramaDirectorSegment['performance']['secondaryEmotions'],
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
  const segmentTexts = rawSegments.map((segment) => record(segment)?.text);
  if (segmentTexts.some((text) => typeof text !== 'string') ||
      segmentTexts.join('') !== input.sourceText) {
    issues.push('Segment text does not exactly match the authoritative source.');
  }
  if (issues.length) throw new DramaDirectorValidationError(issues);
  return segments;
}

export function buildDramaDirectorPrompt(input: { sourceText: string; castNames: readonly string[]; policy?: DramaDirectorPolicy; priorContinuityState?: string; sourceSpans?: readonly DramaSourceSpan[] }): string {
  return [
    'You are the OpenReader Drama Director. Return JSON only: {"segments": [...]} .',
    'Return direction metadata over immutable source span IDs. Cover EVERY ID exactly once in supplied order. Each segment.spanIds is a non-empty contiguous group. Never return text, offsets, rewritten source, or voiceId.',
    'Use only cast names supplied below for speaker. Never choose or emit a voiceId.',
    'Start a new segment whenever the speaker or utterance type changes. Keep narration and speech attribution in narrator segments, separate from character dialogue, internal thoughts, and squad-link turns. Never combine different speakers into one segment.',
    'Formatting is evidence, not proof of utterance type. Internal thought and squad-link may both be italicized; use narrative context. Squad-link uses the character’s natural voice, never an automatic whisper.',
    'Authority is not loudness. High intensity can be quiet and low energy. Performance can change within a thought; split between source spans when needed. Default to tags: []; use vocal cues only for localized effects. A pause applies after the referenced source spans; split at the intended boundary for a pause inside a line.',
    `utteranceType: ${JSON.stringify(DRAMA_UTTERANCE_TYPES)}`,
    `primaryEmotion/secondaryEmotions: ${JSON.stringify(DRAMA_PRIMARY_EMOTIONS)}`,
    `socialIntent: ${JSON.stringify(DRAMA_SOCIAL_INTENTS)}`,
    `delivery: ${JSON.stringify(DRAMA_DELIVERY_STYLES)}`,
    `pace: ${JSON.stringify(DRAMA_PACING)}; energy: ${JSON.stringify(DRAMA_ENERGY)}; intensity: ${JSON.stringify(DRAMA_INTENSITY)}`,
    `Allowed tags only: ${JSON.stringify(DRAMA_INLINE_VOCAL_EVENTS)}. Never regenerate pronunciation markup.`,
    'Emotion is an internal emotional state; socialIntent is interpersonal purpose; delivery is audible speaking style. Friendly belongs to social intent; conversational belongs to delivery, neither is an emotion. Every segment needs spanIds, speaker, utteranceType, sceneContext (one concise sentence), performance with all required fields, and omit_from_audio: false. Source cleanup already decided what to narrate. Use 0–2 secondary emotions, 1–2 delivery styles, and 0–2 safe tags.',
    ...(input.priorContinuityState ? [`Previous scene context: ${JSON.stringify(input.priorContinuityState.slice(0, 1000))}`] : []),
    'Author examples (text is exact; direction illustrates context and performance):',
    ...(input.policy ? [
      `Director policy: ${JSON.stringify(input.policy)}. Apply this as a bias only; preserve scene-appropriate intensity and exact source text.`,
      'Narrator expressiveness applies to narration; character expressiveness applies to character speech. Persistent character direction remains authoritative for identity.',
    ] : []),
    ...DRAMA_DIRECTOR_PROMPT_EXAMPLES.map((example) => JSON.stringify({
      sourceSpans: [{ id: 'example', text: example.text }],
      segments: [{ ...example.direction, performance: { ...example.direction.performance, tags: example.direction.performance.tags.filter((tag) => DRAMA_INLINE_VOCAL_EVENTS.includes(tag as never)) }, spanIds: ['example'], omit_from_audio: false }],
    })),
    `Cast names: ${JSON.stringify(input.castNames)}`,
    `Immutable source spans: ${JSON.stringify(input.sourceSpans ?? createDramaSourceSpans(input.sourceText))}`,
  ].join('\n');
}

/** Two bounded correction requests. The caller supplies its Gemini transport. */
export async function directDramaWithRepair(input: {
  sourceText: string;
  castNames: readonly string[];
  sourceSpans?: readonly DramaSourceSpan[];
  generate: (prompt: string) => Promise<unknown>;
  policy?: DramaDirectorPolicy;
  priorContinuityState?: string;
  onRepair?: (attempt: number, issues: readonly string[]) => void;
}): Promise<DramaDirectorSegment[]> {
  const sourceSpans = input.sourceSpans ?? createDramaSourceSpans(input.sourceText);
  assertDramaSourceSpans(input.sourceText, sourceSpans);
  const prompt = buildDramaDirectorPrompt({ ...input, sourceSpans });
  const attempts: DramaDirectorResponseAttempt[] = [];
  let output: unknown;
  let nextPrompt = prompt;
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    try {
      output = undefined;
      output = await input.generate(nextPrompt);
      return validateDirectedSpanGroups({ ...input, sourceSpans, output });
    } catch (error) {
      if (!(error instanceof DramaDirectorValidationError)) throw error;
      attempts.push({ attempt: attempt + 1, issues: [...error.issues], response: error.response ?? safeDirectorResponse(output), diagnostics: error.diagnostics });
      if (attempt === 2) {
        Object.defineProperty(error, 'attempts', { value: attempts, enumerable: true });
        throw error;
      }
      input.onRepair?.(attempt + 1, error.issues);
      nextPrompt = [
        prompt,
        attempt === 0
          ? 'Your previous JSON failed validation. Return the full corrected JSON object only.'
          : 'Final repair: follow the schema and cover all span IDs in order. Return the full corrected metadata JSON object only.',
        `Validation issues: ${JSON.stringify(error.issues.slice(0, 20)).slice(0, 4000)}`,
        'Regenerate metadata for all supplied spans. Prior output is intentionally excluded.',
      ].join('\n');
    }
  }
  throw new DramaDirectorValidationError(['Director repair attempts exhausted.']);
}

function safeDirectorResponse(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 2_000_000);
  try { return JSON.stringify(value)?.slice(0, 2_000_000) ?? '[no Director response]'; } catch { return '[unserializable Director response]'; }
}

/** JSON Schema from the shared taxonomy, using Gemini's supported subset. */
export function buildDramaDirectorResponseSchema(castNames: readonly string[], spans: readonly DramaSourceSpan[]) {
  const choice = (values: readonly string[], description?: string) => ({ type: 'string', enum: [...values], ...(description ? { description } : {}) });
  const array = (values: readonly string[], minItems: number, maxItems: number) => ({ type: 'array', items: choice(values), minItems, maxItems });
  const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
  return object({ segments: {
    type: 'array', minItems: 1, maxItems: spans.length,
    items: object({
      spanIds: array(spans.map((span) => span.id), 1, spans.length),
      speaker: choice(castNames), utteranceType: choice(DRAMA_UTTERANCE_TYPES),
      sceneContext: { type: 'string', description: 'One concise sentence of scene context.' },
      // Boolean enum/const is outside the documented subset; enforce false
      // authoritatively below rather than relying on an unsupported keyword.
      omit_from_audio: { type: 'boolean', description: 'Must be false. All cleaned source is narratable.' },
      performance: object({
        primaryEmotion: choice(DRAMA_PRIMARY_EMOTIONS, 'Dominant internal emotional state. Not friendly, welcoming, helpful, or conversational.'),
        secondaryEmotions: array(DRAMA_SECONDARY_EMOTIONS, 0, 2),
        socialIntent: choice(DRAMA_SOCIAL_INTENTS, 'Interpersonal purpose toward another character.'),
        delivery: { ...array(DRAMA_DELIVERY_STYLES, 1, 2), description: 'Audible manner of speaking.' },
        pace: choice(DRAMA_PACING), energy: choice(DRAMA_ENERGY), intensity: choice(DRAMA_INTENSITY),
        tags: array(DRAMA_INLINE_VOCAL_EVENTS, 0, 2),
        nuance: { type: 'string', description: 'Optional brief acting hint.' },
      }, ['primaryEmotion', 'secondaryEmotions', 'socialIntent', 'delivery', 'pace', 'energy', 'intensity', 'tags']),
    }),
  } });
}

/** Reject omissions, duplicates, unknown IDs and noncontiguous/reordered groups. */
export function validateDirectedSpanGroups(input: {
  sourceText: string; sourceSpans: readonly DramaSourceSpan[]; castNames: readonly string[];
  output: unknown; policy?: DramaDirectorPolicy;
}): DramaDirectorSegment[] {
  assertDramaSourceSpans(input.sourceText, input.sourceSpans);
  const rawSegments = record(input.output)?.segments;
  if (!Array.isArray(rawSegments) || !rawSegments.length) throw new DramaDirectorValidationError(['Expected a non-empty segments array.']);
  const table = new Map(input.sourceSpans.map((span) => [span.id, span.text]));
  const returned: string[] = [];
  const issues: string[] = [];
  const segments = rawSegments.map((raw, index) => {
    const group = record(raw);
    if (group && 'text' in group) issues.push(`Segment ${index + 1}: text must not be generated.`);
    const ids = group?.spanIds;
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string')) {
      issues.push(`Segment ${index + 1}: spanIds must be a non-empty string array.`);
      return { ...group, text: '' };
    }
    for (const id of ids) returned.push(id);
    return { ...group, text: ids.map((id) => table.get(id) ?? '').join('') };
  });
  const seen = new Set<string>();
  const firstUnknownSpan = returned.find((id) => !table.has(id));
  const firstDuplicateSpan = returned.find((id) => { if (seen.has(id)) return true; seen.add(id); return false; });
  const present = new Set(returned);
  const firstMissingSpan = input.sourceSpans.find((span) => !present.has(span.id))?.id;
  const firstOutOfOrderSpan = returned.find((id, index) => id !== input.sourceSpans[index]?.id);
  const diagnostics = { firstMissingSpan, firstDuplicateSpan, firstOutOfOrderSpan, firstUnknownSpan,
    expectedSpanCount: input.sourceSpans.length, returnedSpanCount: returned.length };
  if (firstUnknownSpan) issues.push(`Unknown source span: ${firstUnknownSpan}.`);
  if (firstDuplicateSpan) issues.push(`Duplicate source span: ${firstDuplicateSpan}.`);
  if (firstMissingSpan) issues.push(`Missing source span: ${firstMissingSpan}.`);
  if (firstOutOfOrderSpan) issues.push(`Out-of-order source span: ${firstOutOfOrderSpan}.`);
  if (issues.length) throw new DramaDirectorValidationError(issues, undefined, diagnostics);
  return validateDramaDirectorOutput({ ...input, output: { segments } });
}

/** Gemini generateContent REST transport; server reconstructs all spoken text. */
export async function directDramaWithGemini(input: {
  sourceText: string;
  sourceSpans?: readonly DramaSourceSpan[];
  castNames: readonly string[];
  apiKey: string;
  backupApiKey?: string;
  model: string;
  policy?: DramaDirectorPolicy;
  priorContinuityState?: string;
  batchIndex?: number;
  signal?: AbortSignal;
  onDiagnostic?: (fields: Record<string, unknown>) => void;
  onRepair?: (attempt: number, issues: readonly string[]) => void;
}): Promise<DramaDirectorSegment[]> {
  const redact = (value: string) => {
    for (const key of [input.apiKey, input.backupApiKey]) if (key) value = value.split(key).join('[redacted]');
    return value;
  };
  const allSpans = input.sourceSpans ?? createDramaSourceSpans(input.sourceText);
  assertDramaSourceSpans(input.sourceText, allSpans);
  const batches = batchDramaSourceSpans(allSpans);
  const directed: DramaDirectorSegment[] = [];
  let continuity = input.priorContinuityState;
  for (const [index, sourceSpans] of batches.entries()) {
    input.signal?.throwIfAborted();
    const sourceText = sourceSpans.map((span) => span.text).join('');
    const base = { batchIndex: (input.batchIndex ?? 0) + index, sourceByteCount: Buffer.byteLength(sourceText, 'utf8'), sourceSpanCount: sourceSpans.length };
    let attempt = 0;
    let provider: Record<string, unknown> = {};
    const emit = (fields: Record<string, unknown>) => {
      const diagnostic = { ...base, ...provider, ...fields };
      serverLogger.info({ event: 'drama_director.diagnostic', ...diagnostic }, 'Drama Director request diagnostic');
      input.onDiagnostic?.(diagnostic);
    };
    const segments = await directDramaWithRepair({
      ...input, sourceText, sourceSpans, priorContinuityState: continuity,
      generate: async (prompt) => {
        input.signal?.throwIfAborted();
        attempt += 1;
        provider = {};
        const { response } = await fetchGeminiWithRateLimitFallback({
          primaryApiKey: input.apiKey, backupApiKey: input.backupApiKey, requestedModel: input.model, signal: input.signal,
          request: (apiKey, model) => fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || input.model)}:generateContent`,
            {
              method: 'POST', signal: input.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
              body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
                // TextResponseFormat.mimeType is a REST enum, unlike the older
                // responseMimeType string field. Keep the structured schema.
                generationConfig: { responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: buildDramaDirectorResponseSchema(input.castNames, sourceSpans) } }, maxOutputTokens: 24_000 },
              }),
            },
          ),
        });
        if (!response.ok) {
          const details = await geminiPrivateErrorDetails(response);
          if (details.message) details.message = redact(details.message);
          provider = { ...base, attempt, httpStatus: response.status };
          emit({ failure: 'provider' });
          throw new DramaDirectorValidationError([
            `Gemini Drama Director provider failure (HTTP ${response.status}${details.apiStatus ? ` ${details.apiStatus}` : ''}): ${details.message || 'No provider message.'}`,
          ], JSON.stringify({ provider: 'gemini', httpStatus: response.status, ...details }).slice(0, 2_000_000), provider);
        }
        const envelope = await response.text();
        let parsedEnvelope: unknown;
        try { parsedEnvelope = JSON.parse(envelope) as unknown; }
        catch {
          provider = { ...base, attempt, responseLength: envelope.length, parseFailure: true };
          emit({ failure: 'invalid-provider-json' });
          throw new DramaDirectorValidationError(['Gemini returned an invalid Director response envelope.'], redact(envelope).slice(0, 2_000_000), provider);
        }
        const data = (record(parsedEnvelope) ?? {}) as {
          candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
          modelVersion?: string;
        };
        const candidate = data.candidates?.[0];
        const jsonText = candidate?.content?.parts?.filter((part) => !part.thought).map((part) => part.text || '').join('') || '';
        provider = { ...base, attempt, finishReason: candidate?.finishReason, modelVersion: data.modelVersion,
          promptTokenCount: data.usageMetadata?.promptTokenCount, candidatesTokenCount: data.usageMetadata?.candidatesTokenCount,
          totalTokenCount: data.usageMetadata?.totalTokenCount, responseLength: jsonText.length };
        let output: unknown;
        try { output = JSON.parse(jsonText) as unknown; }
        catch (error) {
          // Store only parse location, not V8's source excerpt in normal logs.
          const location = error instanceof Error ? error.message.match(/position (\d+)|line (\d+) column (\d+)/u)?.[0] : undefined;
          provider = { ...provider, parseFailure: true, parseErrorLocation: location };
          emit({ failure: 'invalid-json' });
          throw new DramaDirectorValidationError([jsonText ? 'Gemini returned invalid Director JSON.' : 'Gemini returned no Director JSON.'], redact(jsonText).slice(0, 2_000_000), provider);
        }
        const rawSegments = record(output)?.segments;
        provider = { ...provider, directedSegmentCount: Array.isArray(rawSegments) ? rawSegments.length : 0 };
        if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
          emit({ failure: 'incomplete-output' });
          throw new DramaDirectorValidationError([`Gemini Director finish reason: ${candidate.finishReason}.`], redact(jsonText).slice(0, 2_000_000), provider);
        }
        try {
          const validated = validateDirectedSpanGroups({ ...input, sourceText, sourceSpans, output });
          emit({ directedSegmentCount: validated.length });
        } catch (error) {
          if (!(error instanceof DramaDirectorValidationError)) throw error;
          const diagnostics = { ...provider, ...error.diagnostics };
          emit({ ...error.diagnostics, failure: 'validation' });
          throw new DramaDirectorValidationError(error.issues, redact(jsonText).slice(0, 2_000_000), diagnostics);
        }
        return output;
      },
    });
    directed.push(...segments);
    continuity = segments.at(-1)?.sceneContext || continuity;
  }
  return directed;
}
