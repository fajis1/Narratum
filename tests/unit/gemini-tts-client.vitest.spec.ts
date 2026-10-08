import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGeminiTtsRequest,
  extractGeminiTtsAudio,
  GEMINI_TTS_AUDIO_MIME_TYPE,
  GEMINI_TTS_ENDPOINT,
  GEMINI_TTS_FALLBACK_MODELS,
  GEMINI_TTS_MAX_STYLE_BYTES,
  GEMINI_TTS_MODEL,
  GEMINI_TTS_SAMPLE_RATE,
  GeminiTtsApiError,
  GeminiTtsInputError,
  GeminiTtsTransportError,
  synthesizeWithGeminiTts,
} from '../../src/lib/server/smart-audio/gemini-tts-client';

const testApiKey = 'test-api-key';

function wavFixture(): Buffer {
  return Buffer.from('RIFF0000WAVEfmt ');
}

function audioPayload(encodedAudio = wavFixture().toString('base64')) {
  return {
    steps: [{
      type: 'model_output',
      content: [{ type: 'audio', data: encodedAudio }],
    }],
  };
}

function response(payload: unknown, options: {
  ok?: boolean;
  status?: number;
  retryAfter?: string;
} = {}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: new Headers(options.retryAfter ? { 'retry-after': options.retryAfter } : {}),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

describe('Gemini 3.8 TTS request builder', () => {
  it('builds the Interactions schema with exact transcript and speech metadata', () => {
    const request = buildGeminiTtsRequest({
      text: '<sigh> We should go. <short pause>',
      style: 'determined and restrained; measured pace',
      voiceName: 'Kore',
    });

    expect(request).toEqual({
      model: GEMINI_TTS_MODEL,
      input: [{
        type: 'user_input',
        content: [{
          type: 'text',
          text: '<sigh> We should go. <short pause>',
          annotations: [{
            type: 'speech_metadata',
            style: 'determined and restrained; measured pace',
          }],
        }],
      }],
      response_format: {
        type: 'audio',
        mime_type: GEMINI_TTS_AUDIO_MIME_TYPE,
        sample_rate: GEMINI_TTS_SAMPLE_RATE,
      },
      generation_config: {
        speech_config: [{ voice: 'Kore' }],
      },
    });
  });

  it('does not include legacy Cloud TTS fields', () => {
    const serialized = JSON.stringify(buildGeminiTtsRequest({
      text: 'The room was still.',
      voiceName: 'Kore',
    }));

    expect(serialized).not.toContain('audioConfig');
    expect(serialized).not.toContain('modelName');
    expect(serialized).not.toContain('languageCode');
    expect(serialized).not.toContain('speakingRate');
    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('texttospeech.googleapis.com');
  });

  it('uses the same-schema Flash-Lite fallback model when selected', () => {
    const request = buildGeminiTtsRequest({
      text: 'Fallback narration.',
      voiceName: 'Kore',
      modelName: GEMINI_TTS_FALLBACK_MODELS[0],
    });

    expect(request.model).toBe('gemini-3.8-flash-lite-tts');
  });

  it('rejects missing input and an overlong style string', () => {
    expect(() => buildGeminiTtsRequest({
      text: ' ',
      voiceName: 'Kore',
    })).toThrow(GeminiTtsInputError);
    expect(() => buildGeminiTtsRequest({
      text: 'Narration',
      voiceName: '',
    })).toThrow(GeminiTtsInputError);
    expect(() => buildGeminiTtsRequest({
      text: 'Narration',
      voiceName: 'Kore',
      style: 'x'.repeat(GEMINI_TTS_MAX_STYLE_BYTES + 1),
    })).toThrow(GeminiTtsInputError);
  });
});

describe('Gemini 3.8 TTS response parsing', () => {
  it('selects the last audio item from model-output steps only', () => {
    const first = Buffer.from('RIFF-first').toString('base64');
    const last = Buffer.from('RIFF-last').toString('base64');

    expect(extractGeminiTtsAudio({
      steps: [
        { type: 'user_input', content: [{ type: 'audio', data: first }] },
        { type: 'model_output', content: [{ type: 'audio', data: first }] },
        { type: 'model_output', content: [{ type: 'text', text: 'ignored' }, { type: 'audio', data: last }] },
      ],
    })).toBe(last);
  });

  it('returns undefined when no model-output audio exists', () => {
    expect(extractGeminiTtsAudio({ steps: [{ type: 'model_output', content: [] }] })).toBeUndefined();
  });
});

describe('synthesizeWithGeminiTts', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the Gemini Interactions endpoint and returns WAV data', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(response(audioPayload()));
    }));

    const result = await synthesizeWithGeminiTts({
      text: 'The room had gone completely still.',
      style: 'calm, restrained, slow and reflective',
      voiceName: 'Kore',
      apiKey: testApiKey,
    });

    expect(capturedUrl).toBe(GEMINI_TTS_ENDPOINT);
    expect(capturedInit?.headers).toMatchObject({
      'Content-Type': 'application/json; charset=utf-8',
      'x-goog-api-key': testApiKey,
    });
    expect(result.audioBuffer.subarray(0, 4).toString()).toBe('RIFF');
    expect(result).toMatchObject({
      audioFormat: 'wav',
      mimeType: 'audio/wav',
      sampleRate: 24000,
      usedModel: 'gemini-3.8-flash-tts',
    });
  });

  it('rejects a missing API key before making a request', async () => {
    await expect(synthesizeWithGeminiTts({
      text: 'Narration',
      voiceName: 'Kore',
      apiKey: '',
    })).rejects.toThrow(GeminiTtsInputError);
  });

  it.each([
    [400, 'INVALID_ARGUMENT', false],
    [401, 'UNAUTHENTICATED', false],
    [403, 'PERMISSION_DENIED', false],
    [429, 'RESOURCE_EXHAUSTED', true],
    [500, 'INTERNAL', true],
  ])('classifies HTTP %i API errors without treating them as success', async (status, providerStatus, retryable) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      error: { message: 'upstream error', status: providerStatus },
    }, { ok: false, status, retryAfter: retryable ? '2' : undefined })));

    const error = await synthesizeWithGeminiTts({
      text: 'Narration',
      voiceName: 'Kore',
      apiKey: testApiKey,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GeminiTtsApiError);
    expect(error).toMatchObject({
      statusCode: status,
      detail: 'upstream error',
      providerStatus,
      modelName: GEMINI_TTS_MODEL,
    });
    if (retryable) {
      expect((error as GeminiTtsApiError).retryAfterMs).toBe(2000);
    } else {
      expect((error as GeminiTtsApiError).retryAfterMs).toBeUndefined();
    }
  });

  it('rejects a successful response whose audio bytes are not RIFF/WAVE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(audioPayload(Buffer.from('not-a-wav').toString('base64')))));
    await expect(synthesizeWithGeminiTts({ text: 'Narration', voiceName: 'Kore', apiKey: testApiKey })).rejects.toThrow('not a WAV payload');
  });

  it('forwards the cancellation signal to fetch', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(response(audioPayload()));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeWithGeminiTts({ text: 'Narration', voiceName: 'Kore', apiKey: testApiKey, signal: controller.signal });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
  });

  it('throws when a successful response has no audio content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'not audio' }] }],
    })));

    await expect(synthesizeWithGeminiTts({
      text: 'Narration',
      voiceName: 'Kore',
      apiKey: testApiKey,
    })).rejects.toThrow('did not include model-output audio');
  });

  it('wraps network failures as a Gemini transport error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));

    await expect(synthesizeWithGeminiTts({
      text: 'Narration',
      voiceName: 'Kore',
      apiKey: testApiKey,
    })).rejects.toThrow(GeminiTtsTransportError);
  });
});


describe('Gemini TTS troubleshooting capture', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('captures safe request settings, usage and audio size on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...audioPayload(), usage: { total_tokens: 8 } })));
    const onDiagnostic = vi.fn().mockResolvedValue(undefined);
    await synthesizeWithGeminiTts({ apiKey: testApiKey, text: 'Hi', voiceName: 'Kore', style: 'warm', onDiagnostic });
    const record = onDiagnostic.mock.calls[0][0];
    expect(record).toMatchObject({ httpStatus: 200, audioBytes: wavFixture().length, response: { usage: { total_tokens: 8 } }, request: { model: GEMINI_TTS_MODEL } });
    expect(record.request.input[0].content[0]).toMatchObject({ text: 'Hi', annotations: [{ style: 'warm' }] });
    expect(JSON.stringify(record)).not.toContain(testApiKey);
    expect(JSON.stringify(record)).not.toContain(wavFixture().toString('base64'));
  });
  it('retains structured quota details and retry timing before throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { message: testApiKey, status: 'RESOURCE_EXHAUSTED', details: [{ quotaId: 'daily' }] } }, { ok: false, status: 429, retryAfter: '60' })));
    const onDiagnostic = vi.fn().mockResolvedValue(undefined);
    await expect(synthesizeWithGeminiTts({ apiKey: testApiKey, text: 'Hi', voiceName: 'Kore', onDiagnostic })).rejects.toBeInstanceOf(GeminiTtsApiError);
    expect(onDiagnostic.mock.calls[0][0]).toMatchObject({ httpStatus: 429, retryAfterMs: 60000, response: { error: { message: '[REDACTED]', details: [{ quotaId: 'daily' }] } } });
  });
  it('captures transport failures without credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const onDiagnostic = vi.fn().mockResolvedValue(undefined);
    await expect(synthesizeWithGeminiTts({ apiKey: testApiKey, text: 'Hi', voiceName: 'Kore', onDiagnostic })).rejects.toBeInstanceOf(GeminiTtsTransportError);
    expect(onDiagnostic).toHaveBeenCalledOnce();
  });
  it('keeps successful audio when diagnostic retention fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(audioPayload())));
    const result = await synthesizeWithGeminiTts({ apiKey: testApiKey, text: 'Hi', voiceName: 'Kore', onDiagnostic: async () => { throw new Error('storage'); } });
    expect(result.audioBuffer).toEqual(wavFixture());
    expect(fetch).toHaveBeenCalledOnce();
  });
});
