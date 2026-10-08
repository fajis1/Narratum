import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRAMA_UTTERANCE_TYPES, DRAMA_PRIMARY_EMOTIONS, DRAMA_SECONDARY_EMOTIONS,
  DRAMA_SOCIAL_INTENTS, DRAMA_DELIVERY_STYLES, DRAMA_PACING, DRAMA_ENERGY,
  DRAMA_INTENSITY, DRAMA_INLINE_VOCAL_EVENTS,
} from '@/lib/shared/drama-director-schema';
import { createDramaSourceSpans, batchDramaSourceSpans, DRAMA_DIRECTOR_MAX_SPANS } from '@/lib/server/smart-audio/drama-source-spans';
import { buildDramaDirectorResponseSchema, directDramaWithRepair, directDramaWithGemini, validateDirectedSpanGroups } from '@/lib/server/smart-audio/drama-director';

vi.mock('@/lib/server/logger', () => ({ serverLogger: { info: vi.fn() } }));
vi.mock('@/lib/server/smart-audio/gemini-failover', () => ({
  fetchGeminiWithRateLimitFallback: async (options: { primaryApiKey: string; requestedModel: string; request: (key: string, model: string) => Promise<Response> }) => ({ response: await options.request(options.primaryApiKey, options.requestedModel) }),
}));
const performance = { primaryEmotion: 'calm', secondaryEmotions: [], socialIntent: 'informing', delivery: ['natural'], pace: 'normal', energy: 'low', intensity: 'low', tags: [] };
const group = (spanIds: string[]) => ({ spanIds, speaker: 'Narrator', utteranceType: 'narration', sceneContext: 'Opening.', omit_from_audio: false, performance });
const spans = [...'ABCD'].map((text) => ({ id: text, text }));
const input = { sourceText: 'ABCD', sourceSpans: spans, castNames: ['Narrator'] };
const envelope = (text: string, finishReason = 'STOP') => new Response(JSON.stringify({
  candidates: [{ finishReason, content: { parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 100, totalTokenCount: 400 }, modelVersion: 'gemini-test',
}), { status: 200 });
afterEach(() => vi.unstubAllGlobals());

describe('immutable Director metadata', () => {
  it('derives every enum from the shared authoritative vocabulary', () => {
    const schema = buildDramaDirectorResponseSchema(input.castNames, spans);
    const fields = schema.properties.segments as { items: { properties: Record<string, { enum?: string[]; items?: { enum: string[] }; properties?: Record<string, { enum?: readonly string[]; items?: { enum: readonly string[] }; minItems?: number; maxItems?: number }> }> } };
    expect(fields.items.properties.speaker.enum).toEqual(input.castNames);
    expect(fields.items.properties.spanIds.items!.enum).toEqual(spans.map((span) => span.id));
    expect(fields.items.properties.utteranceType.enum).toEqual(DRAMA_UTTERANCE_TYPES);
    const props = fields.items.properties.performance.properties!;
    for (const [field, vocabulary] of Object.entries({ primaryEmotion: DRAMA_PRIMARY_EMOTIONS, socialIntent: DRAMA_SOCIAL_INTENTS, pace: DRAMA_PACING, energy: DRAMA_ENERGY, intensity: DRAMA_INTENSITY })) expect(props[field].enum).toEqual(vocabulary);
    for (const [field, vocabulary] of Object.entries({ secondaryEmotions: DRAMA_SECONDARY_EMOTIONS, delivery: DRAMA_DELIVERY_STYLES, tags: DRAMA_INLINE_VOCAL_EVENTS })) expect(props[field].items!.enum).toEqual(vocabulary);
    expect(props.primaryEmotion.enum).not.toContain('friendly');
    expect(props.socialIntent.enum).not.toContain('conversational');
    expect(props.delivery).toMatchObject({ minItems: 1, maxItems: 2 });
    expect(props.secondaryEmotions.maxItems).toBe(2);
    expect(props.tags.maxItems).toBe(2);
    expect(fields.items.properties).not.toHaveProperty('text');
  });

  it('reconstructs grouped spans byte for byte', () => {
    const segments = validateDirectedSpanGroups({ ...input, output: { segments: [group(['A', 'B']), group(['C']), group(['D'])] } });
    expect(segments.map((segment) => segment.text)).toEqual(['AB', 'C', 'D']);
    expect(Buffer.from(segments.map((segment) => segment.text).join(''))).toEqual(Buffer.from('ABCD'));
  });

  it.each([
    [['A', 'B', 'D'], 'Missing'], [['A', 'B', 'B', 'C', 'D'], 'Duplicate'],
    [['A', 'C', 'B', 'D'], 'Out-of-order'], [['A', 'B', 'C', 'D', 's9999'], 'Unknown'],
  ])('rejects invalid global coverage %j', (ids, reason) => {
    expect(() => validateDirectedSpanGroups({ ...input, output: { segments: [group(ids)] } })).toThrow(reason);
  });

  it('rejects metadata enum drift and generated source text', () => {
    for (const changes of [
      { performance: { ...performance, primaryEmotion: 'friendly' } },
      { performance: { ...performance, socialIntent: 'conversational' } },
      { performance: { ...performance, secondaryEmotions: ['helpful'] } },
      { performance: { ...performance, tags: ['scared'] } },
      { omit_from_audio: true }, { speaker: 'Unknown' }, { text: 'ABCD' },
    ]) expect(() => validateDirectedSpanGroups({ ...input, output: { segments: [{ ...group(['A', 'B', 'C', 'D']), ...changes }] } })).toThrow();
  });

  it.each([
    `Chapter 1\r\n\r\n"Don't..." she said. “It’s fine—really…”\n[Bethany](/bɛθəni/) met [Dominic](/dɒmɪnɪk/).`,
    'Bethany let out a breath ... I have Reshi\n\nworking on the garden...\n\nLast sentence.',
  ])('preserves punctuation, markup and PDF wrapping: %s', async (sourceText) => {
    const sourceSpans = createDramaSourceSpans(sourceText);
    expect(sourceSpans.map((span) => span.text).join('')).toBe(sourceText);
    for (const markup of sourceText.match(/\[[^\]]+\]\(\/[^)]*\/\)/gu) || []) expect(sourceSpans.some((span) => span.text.includes(markup))).toBe(true);
    const generate = vi.fn().mockResolvedValue({ segments: [group(sourceSpans.map((span) => span.id))] });
    const directed = await directDramaWithRepair({ sourceText, castNames: ['Narrator'], generate });
    expect(Buffer.from(directed.map((segment) => segment.text).join(''))).toEqual(Buffer.from(sourceText));
    expect(generate.mock.calls[0][0]).not.toContain('segment.text must equal');
  });

  it('exposes safe boundaries between dialogue and attribution', () => {
    const sourceSpans = createDramaSourceSpans('She said, “Hello.” He replied, "Goodbye."\n');
    expect(sourceSpans.map((span) => span.text).join('')).toBe('She said, “Hello.” He replied, "Goodbye."\n');
    expect(sourceSpans.some((span) => span.text === 'She said, ')).toBe(true);
    expect(sourceSpans.some((span) => span.text === ' He replied, ')).toBe(true);
  });

  it('bounds dialogue-heavy batches by both spans and bytes, with stable IDs', () => {
    const sourceText = Array.from({ length: 220 }, (_, index) => `“Turn ${index}.” Alice said.\n`).join('');
    const sourceSpans = createDramaSourceSpans(sourceText);
    const batches = batchDramaSourceSpans(sourceSpans);
    expect(batches.length).toBeGreaterThan(5);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(DRAMA_DIRECTOR_MAX_SPANS);
      expect(Buffer.byteLength(batch.map((span) => span.text).join(''))).toBeLessThanOrEqual(12_000);
    }
    expect(batches.flat()).toEqual(sourceSpans);
    expect(batches.flat().map((span) => span.text).join('')).toBe(sourceText);
    expect(createDramaSourceSpans(sourceText)).toEqual(sourceSpans);
    const prose = createDramaSourceSpans('Prose without a sentence break '.repeat(1000));
    expect(batchDramaSourceSpans(prose).every((batch) => Buffer.byteLength(batch.map((span) => span.text).join('')) <= 12_000)).toBe(true);
    expect(() => batchDramaSourceSpans([{ id: 'large', text: 'x'.repeat(12_001) }])).toThrow(/exceeds/);
  });

  it('keeps repairs bounded without including huge previous JSON or accumulating attempts', async () => {
    const huge = { segments: [], untrusted: 'previous giant output'.repeat(20_000) };
    const generate = vi.fn().mockResolvedValue(huge);
    await expect(directDramaWithRepair({ ...input, generate })).rejects.toThrow();
    const prompts = generate.mock.calls.map((call) => call[0]);
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) expect(prompt).not.toContain('previous giant output');
    expect(prompts[1].length - prompts[0].length).toBeLessThan(4500);
    expect(prompts[2].length - prompts[0].length).toBeLessThan(4500);
  });

  it('uses the verified REST schema contract and safely retries malformed JSON', async () => {
    const diagnostic = vi.fn();
    const fetch = vi.fn().mockResolvedValueOnce(envelope('{"segments": ["bad quote]', 'MAX_TOKENS'))
      .mockResolvedValueOnce(envelope(JSON.stringify({ segments: [group(['A', 'B', 'C', 'D'])] })));
    vi.stubGlobal('fetch', fetch);
    const result = await directDramaWithGemini({ ...input, apiKey: 'private-test-credential', model: 'gemini-3.8-flash', batchIndex: 7, onDiagnostic: diagnostic });
    expect(result.map((segment) => segment.text).join('')).toBe('ABCD');
    const config = JSON.parse(fetch.mock.calls[0][1].body).generationConfig;
    expect(config.responseFormat.text).toEqual({ mimeType: 'APPLICATION_JSON', schema: buildDramaDirectorResponseSchema(input.castNames, spans) });
    expect(fetch.mock.calls[0][0]).not.toContain('private-test-credential');
    expect(diagnostic.mock.calls[0][0]).toMatchObject({ batchIndex: 7, finishReason: 'MAX_TOKENS', responseLength: 25, parseFailure: true, sourceSpanCount: 4, sourceByteCount: 4, promptTokenCount: 300, candidatesTokenCount: 100, totalTokenCount: 400, modelVersion: 'gemini-test' });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-test-credential');
  });

  it('sends the enum MIME type accepted by the provider instead of the production HTTP 400 value', async () => {
    const fetch = vi.fn().mockImplementation((_url, request) => {
      const config = JSON.parse(request.body).generationConfig;
      // Mirror TextResponseFormat.MimeType's REST contract, not the old string field.
      if (config.responseFormat?.text?.mimeType !== 'APPLICATION_JSON') {
        return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: "Invalid value at 'generation_config.response_format.text.mime_type': application/json" } }, { status: 400 });
      }
      expect(config.responseFormat.text.schema).toEqual(buildDramaDirectorResponseSchema(input.castNames, spans));
      expect(config).not.toHaveProperty('responseMimeType');
      return envelope(JSON.stringify({ segments: [group(['A', 'B', 'C', 'D'])] }));
    });
    vi.stubGlobal('fetch', fetch);
    const result = await directDramaWithGemini({ ...input, apiKey: 'fixture', model: 'gemini-3.8-flash' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.map(segment => segment.text).join('')).toBe('ABCD');
  });

  it('retries the production generic 400 once with the same schema in the legacy wire contract', async () => {
    const diagnostic = vi.fn();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' } }, { status: 400 }))
      .mockResolvedValueOnce(envelope(JSON.stringify({ segments: [group(['A', 'B', 'C', 'D'])] })));
    vi.stubGlobal('fetch', fetch);
    const result = await directDramaWithGemini({ ...input, apiKey: 'secret', model: 'gemini-3.8-flash', onDiagnostic: diagnostic });
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetch.mock.calls[0][1].body);
    const second = JSON.parse(fetch.mock.calls[1][1].body);
    expect(second.contents).toEqual(first.contents);
    expect(second.generationConfig.responseMimeType).toBe('application/json');
    expect(second.generationConfig.responseJsonSchema).toEqual(first.generationConfig.responseFormat.text.schema);
    expect(second.generationConfig).not.toHaveProperty('responseFormat');
    expect(result.map(segment => segment.text).join('')).toBe('ABCD');
    expect(diagnostic.mock.calls[0][0]).toMatchObject({ httpStatus: 400, outputContract: 'responseFormat', contractFallback: 'responseJsonSchema' });
    expect(diagnostic.mock.calls.at(-1)![0]).toMatchObject({ outputContract: 'responseJsonSchema', requestedModel: 'gemini-3.8-flash' });
  });

  it('stops permanent request rejections without pretending Gemini generated repairable metadata', async () => {
    const diagnostic = vi.fn();
    const onRepair = vi.fn();
    const fetch = vi.fn().mockImplementation(() => Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid argument private-credential' } }, { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const error = await directDramaWithGemini({ ...input, apiKey: 'private-credential', model: 'gemini-3.8-flash', batchIndex: 8, onDiagnostic: diagnostic, onRepair }).catch(value => value);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onRepair).not.toHaveBeenCalled();
    expect(error.attempts).toHaveLength(1);
    expect(error.attempts[0].diagnostics).toMatchObject({ httpStatus: 400, apiStatus: 'INVALID_ARGUMENT', batchIndex: 8, outputContract: 'responseJsonSchema',
      contractFailures: [{ contract: 'responseFormat', status: 400, message: 'Invalid argument [redacted]' }] });
    expect(JSON.stringify(error.attempts)).not.toContain('private-credential');
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('Invalid argument');
  });

  it('never downgrades the schema contract on quota or availability failures', async () => {
    for (const status of [429, 503]) {
      const fetch = vi.fn().mockImplementation(() => Response.json({ error: { code: status, status: 'UNAVAILABLE', message: 'Provider unavailable' } }, { status }));
      vi.stubGlobal('fetch', fetch);
      await expect(directDramaWithGemini({ ...input, apiKey: 'fixture', model: 'gemini-3.8-flash' })).rejects.toThrow();
      for (const call of fetch.mock.calls) expect(JSON.parse(call[1].body).generationConfig).not.toHaveProperty('responseJsonSchema');
    }
  });

  it('retains finish, parse and batch diagnostics in the bounded failure artifact', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => envelope('{broken', 'MAX_TOKENS')));
    const error = await directDramaWithGemini({ ...input, apiKey: 'secret', model: 'gemini-3.8-flash', batchIndex: 3 }).catch((value) => value);
    expect(error.attempts).toHaveLength(3);
    expect(error.attempts[0].diagnostics.parseErrorLocation).toMatch(/^(position|line) /u);
    expect(error.attempts[0]).toMatchObject({ response: '{broken', diagnostics: { batchIndex: 3, finishReason: 'MAX_TOKENS', responseLength: 7, parseFailure: true } });
    expect(JSON.stringify(error.attempts)).not.toContain('secret');
  });

  it('diagnoses invalid provider envelopes and never exposes configured credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Response('invalid private-credential envelope', { status: 200 })));
    const error = await directDramaWithGemini({ ...input, apiKey: 'private-credential', model: 'gemini-3.8-flash', batchIndex: 4 }).catch((value) => value);
    expect(error.attempts).toHaveLength(3);
    expect(error.attempts[0].diagnostics).toMatchObject({ batchIndex: 4, parseFailure: true, responseLength: 35 });
    expect(error.attempts[0].response).toBe('invalid [redacted] envelope');
    expect(JSON.stringify(error.attempts)).not.toContain('private-credential');
  });

  it('retains an empty provider response as empty rather than a stale prior attempt', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(envelope(JSON.stringify({ segments: [group(['A'])] })))
      .mockImplementation(() => envelope(''));
    vi.stubGlobal('fetch', fetch);
    const error = await directDramaWithGemini({ ...input, apiKey: 'secret', model: 'gemini-3.8-flash' }).catch((value) => value);
    expect(error.attempts[1].response).toBe('');
    expect(error.attempts[2].response).toBe('');
    expect(error.attempts[1].diagnostics.responseLength).toBe(0);
  });

  it('does not call Gemini after cancellation', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(directDramaWithGemini({ ...input, apiKey: 'secret', model: 'gemini-3.8-flash', signal: controller.signal })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('captures coverage details and rejects even parseable truncated output', async () => {
    const diagnostic = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => envelope(JSON.stringify({ segments: [group(['A', 'B', 'D'])] }))));
    const error = await directDramaWithGemini({ ...input, apiKey: 'secret', model: 'gemini-3.8-flash', onDiagnostic: diagnostic }).catch((value) => value);
    expect(error.attempts[0].diagnostics).toMatchObject({ firstMissingSpan: 'C', firstOutOfOrderSpan: 'D', expectedSpanCount: 4, returnedSpanCount: 3 });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => envelope(JSON.stringify({ segments: [group(['A', 'B', 'C', 'D'])] }), 'MAX_TOKENS')));
    await expect(directDramaWithGemini({ ...input, apiKey: 'secret', model: 'gemini-3.8-flash' })).rejects.toThrow(/finish reason/);
  });
});
