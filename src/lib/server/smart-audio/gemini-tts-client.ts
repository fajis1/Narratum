/**
 * Low-level Gemini 3.8 Text-to-Speech client.
 *
 * This transport intentionally remains separate from the legacy Google Cloud
 * Text-to-Speech adapter. Gemini 3.8 uses the Gemini Interactions API,
 * Gemini API keys, speech metadata, and unary WAV responses.
 */

export const GEMINI_TTS_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/interactions';

export const GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts';

export const GEMINI_TTS_FALLBACK_MODELS = [
  'gemini-3.8-flash-lite-tts',
] as const;

export const GEMINI_TTS_MODELS = [
  GEMINI_TTS_MODEL,
  ...GEMINI_TTS_FALLBACK_MODELS,
] as const;

export type GeminiTtsModel = (typeof GEMINI_TTS_MODELS)[number];

export const GEMINI_TTS_AUDIO_MIME_TYPE = 'audio/wav';
export const GEMINI_TTS_SAMPLE_RATE = 24_000;
export const GEMINI_TTS_MAX_STYLE_BYTES = 600;

export interface GeminiTtsSynthesisOptions {
  /** The authoritative transcript. This client never rewrites it. */
  text: string;
  /** Concise turn-level delivery direction for speech_metadata.style. */
  style?: string;
  /** Gemini prebuilt or supported voice identifier, for example "Kore". */
  voiceName: string;
  /** Gemini 3.8 TTS model. Defaults to Gemini 3.8 Flash TTS. */
  modelName?: GeminiTtsModel;
  /** Gemini API key. It is sent only as the x-goog-api-key header. */
  apiKey: string;
  /** Allows audiobook cancellation to abort an in-flight provider request. */
  signal?: AbortSignal;
}

export interface GeminiTtsSynthesisResult {
  audioBuffer: Buffer;
  audioFormat: 'wav';
  mimeType: typeof GEMINI_TTS_AUDIO_MIME_TYPE;
  sampleRate: typeof GEMINI_TTS_SAMPLE_RATE;
  usedModel: GeminiTtsModel;
}

interface GeminiTtsInteractionRequest {
  model: GeminiTtsModel;
  input: Array<{
    type: 'user_input';
    content: Array<{
      type: 'text';
      text: string;
      annotations?: Array<{
        type: 'speech_metadata';
        style: string;
      }>;
    }>;
  }>;
  response_format: {
    type: 'audio';
    mime_type: typeof GEMINI_TTS_AUDIO_MIME_TYPE;
    sample_rate: typeof GEMINI_TTS_SAMPLE_RATE;
  };
  generation_config: {
    speech_config: Array<{
      voice: string;
    }>;
  };
}

interface GeminiApiErrorPayload {
  error?: {
    message?: unknown;
    status?: unknown;
    code?: unknown;
  };
}

export class GeminiTtsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiTtsInputError';
  }
}

export class GeminiTtsApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly detail: string,
    public readonly modelName: GeminiTtsModel,
    public readonly providerStatus?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GeminiTtsApiError';
  }
}

export class GeminiTtsQuotaExhaustedError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GeminiTtsQuotaExhaustedError';
  }
}

export function isGeminiTtsQuotaExhaustedError(error: unknown): error is GeminiTtsQuotaExhaustedError {
  return error instanceof GeminiTtsQuotaExhaustedError;
}

export class GeminiTtsTransportError extends Error {
  constructor(cause: unknown) {
    super('Failed to reach the Gemini TTS endpoint.', { cause });
    this.name = 'GeminiTtsTransportError';
  }
}

export function isGeminiTtsModel(value: string): value is GeminiTtsModel {
  return (GEMINI_TTS_MODELS as readonly string[]).includes(value);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function resolveModel(modelName?: GeminiTtsModel): GeminiTtsModel {
  const model = modelName ?? GEMINI_TTS_MODEL;
  if (!isGeminiTtsModel(model)) {
    throw new GeminiTtsInputError(`Unsupported Gemini TTS model: ${model}.`);
  }
  return model;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

function getResponseError(payload: unknown): { detail: string; providerStatus?: string } {
  if (!payload || typeof payload !== 'object') {
    return { detail: String(payload) };
  }

  const error = (payload as GeminiApiErrorPayload).error;
  if (!error || typeof error !== 'object') {
    return { detail: JSON.stringify(payload) };
  }

  const detail = typeof error.message === 'string'
    ? error.message
    : JSON.stringify(payload);
  const providerStatus = typeof error.status === 'string' ? error.status : undefined;
  return { detail, providerStatus };
}

export function buildGeminiTtsRequest(
  options: Omit<GeminiTtsSynthesisOptions, 'apiKey'>,
): GeminiTtsInteractionRequest {
  const text = options.text;
  const voiceName = options.voiceName.trim();
  const style = options.style?.trim();
  const model = resolveModel(options.modelName);

  if (!text.trim()) {
    throw new GeminiTtsInputError('Text must not be empty.');
  }
  if (!voiceName) {
    throw new GeminiTtsInputError('Voice name must not be empty.');
  }
  if (style && byteLength(style) > GEMINI_TTS_MAX_STYLE_BYTES) {
    throw new GeminiTtsInputError(
      `Style exceeds the Narratum quality limit of ${GEMINI_TTS_MAX_STYLE_BYTES} UTF-8 bytes.`,
    );
  }

  return {
    model,
    input: [{
      type: 'user_input',
      content: [{
        type: 'text',
        text,
        ...(style ? {
          annotations: [{
            type: 'speech_metadata',
            style,
          }],
        } : {}),
      }],
    }],
    response_format: {
      type: 'audio',
      mime_type: GEMINI_TTS_AUDIO_MIME_TYPE,
      sample_rate: GEMINI_TTS_SAMPLE_RATE,
    },
    generation_config: {
      speech_config: [{ voice: voiceName }],
    },
  };
}

export function extractGeminiTtsAudio(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const steps = (response as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return undefined;

  let lastAudio: string | undefined;
  for (const step of steps) {
    if (!step || typeof step !== 'object' || (step as { type?: unknown }).type !== 'model_output') {
      continue;
    }
    const content = (step as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (
        item &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'audio' &&
        typeof (item as { data?: unknown }).data === 'string' &&
        (item as { data: string }).data
      ) {
        lastAudio = (item as { data: string }).data;
      }
    }
  }

  return lastAudio;
}

export async function synthesizeWithGeminiTts(
  options: GeminiTtsSynthesisOptions,
): Promise<GeminiTtsSynthesisResult> {
  if (!options.apiKey.trim()) {
    throw new GeminiTtsInputError('Gemini API key must not be empty.');
  }

  const requestBody = buildGeminiTtsRequest(options);
  let response: Response;
  try {
    response = await fetch(GEMINI_TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'x-goog-api-key': options.apiKey,
      },
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });
  } catch (error) {
    throw new GeminiTtsTransportError(error);
  }

  if (!response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = await response.text().catch(() => '');
    }
    const { detail, providerStatus } = getResponseError(payload);
    const retryAfterMs = parseRetryAfterMs(response.headers?.get('retry-after') ?? null);
    throw new GeminiTtsApiError(
      `Gemini TTS returned HTTP ${response.status}: ${detail}`,
      response.status,
      detail,
      requestBody.model,
      providerStatus,
      retryAfterMs,
    );
  }

  const payload = await response.json() as unknown;
  const encodedAudio = extractGeminiTtsAudio(payload);
  if (!encodedAudio) {
    throw new GeminiTtsApiError(
      'Gemini TTS response did not include model-output audio.',
      response.status,
      'Missing steps[].content[] audio item',
      requestBody.model,
    );
  }

  const audioBuffer = Buffer.from(encodedAudio, 'base64');
  if (audioBuffer.length === 0) {
    throw new GeminiTtsApiError(
      'Gemini TTS response contained empty audio.',
      response.status,
      'Empty base64 audio payload',
      requestBody.model,
    );
  }
  if (audioBuffer.subarray(0, 4).toString('ascii') !== 'RIFF' || audioBuffer.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new GeminiTtsApiError(
      'Gemini TTS response was not a WAV payload.',
      response.status,
      'Expected RIFF/WAVE header',
      requestBody.model,
    );
  }

  return {
    audioBuffer,
    audioFormat: 'wav',
    mimeType: GEMINI_TTS_AUDIO_MIME_TYPE,
    sampleRate: GEMINI_TTS_SAMPLE_RATE,
    usedModel: requestBody.model,
  };
}
