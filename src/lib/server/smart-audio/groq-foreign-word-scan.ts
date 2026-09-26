import { serverLogger } from '@/lib/server/logger';
import { setTimeout as delay } from 'node:timers/promises';
import type { GeminiForeignWordResult } from './gemini-foreign-word-scan';
import { parseGeminiForeignWordResults } from './gemini-foreign-word-scan';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_DEFAULT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
export const GROQ_FALLBACK_MODELS: readonly string[] = [
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'llama-3.3-70b-versatile',
];
export const GROQ_MAX_CANDIDATES_PER_SUB_BATCH = 7;
export const GROQ_MAX_OUTPUT_TOKENS = 3072;
export const MAX_GROQ_429_RETRIES = 3;

export interface GroqForeignWordOptions {
  signal?: AbortSignal;
  model?: string;
  fallbackModels?: readonly string[];
  maxCandidatesPerSubBatch?: number;
  max429Retries?: number;
  onStatusUpdate?: (statusMessage: string) => Promise<void> | void;
}

const sleep = async (ms: number, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  if (process.env.NODE_ENV !== 'test') await delay(ms, undefined, { signal });
  signal?.throwIfAborted();
};

/**
 * Extracts wait duration in seconds from Groq 429 response headers or body.
 */
export function parseGroqRetryAfter(response: Response, errorBody: string): number {
  const header = response.headers.get('retry-after');
  if (header) {
    const parsed = parseFloat(header);
    if (!isNaN(parsed) && parsed > 0) return Math.min(Math.ceil(parsed), 60);
  }
  const resetTokens = response.headers.get('x-ratelimit-reset-tokens');
  if (resetTokens) {
    const match = resetTokens.match(/([\d.]+)/);
    if (match) {
      const parsed = parseFloat(match[1]);
      if (!isNaN(parsed) && parsed > 0) return Math.min(Math.ceil(parsed), 60);
    }
  }
  const bodyMatch = errorBody.match(/try again in ([\d.]+)\s*s/i);
  if (bodyMatch) {
    const parsed = parseFloat(bodyMatch[1]);
    if (!isNaN(parsed) && parsed > 0) return Math.min(Math.ceil(parsed), 60);
  }
  return 5;
}

/**
 * Checks if an HTTP error indicates that a requested model is unavailable,
 * not found, or decommissioned on Groq.
 */
export function isGroqModelUnavailable(status: number, errorText: string): boolean {
  if (status === 404) return true;
  const lower = errorText.toLowerCase();
  return (
    lower.includes('model_not_found')
    || lower.includes('model not found')
    || lower.includes('does not exist')
    || lower.includes('not have access')
    || lower.includes('decommissioned')
    || lower.includes('unsupported model')
  );
}

function groqObjectPrompt(prompt: string): string {
  const aligned = prompt.replace(
    'Return a JSON array with exactly one result object per requested term.',
    'Return a JSON object with a "results" array containing exactly one result object per requested term.',
  );
  const instruction = 'Groq response format: return one JSON object shaped {"results":[...]}; never a top-level array.';
  const termsBoundary = aligned.search(/\n+Terms:\s*\n/i);
  return termsBoundary < 0
    ? `${aligned}\n\n${instruction}`
    : `${aligned.slice(0, termsBoundary)}\n${instruction}${aligned.slice(termsBoundary)}`;
}

/**
 * Sends a single prompt to Groq, handling 429 rate limits and model fallbacks.
 */
async function sendGroqPromptWithFallback(
  prompt: string,
  groqApiKey: string,
  options: GroqForeignWordOptions,
): Promise<GeminiForeignWordResult[]> {
  const maskedKey = groqApiKey.length >= 4 ? `...${groqApiKey.slice(-4)}` : 'Key';
  const requestedModel = options.model || GROQ_DEFAULT_MODEL;
  const candidateModels = [
    requestedModel,
    ...(options.fallbackModels ?? GROQ_FALLBACK_MODELS.filter((m) => m !== requestedModel)),
  ];
  const max429Retries = options.max429Retries ?? MAX_GROQ_429_RETRIES;

  let lastError: unknown = null;

  for (const model of candidateModels) {
    let retries429 = 0;

    while (retries429 <= max429Retries) {
      options.signal?.throwIfAborted();

      serverLogger.info({
        event: 'pdf.scan.groq.request',
        maskedKey,
        model,
        attempt: retries429 + 1,
      }, 'Sending foreign-word batch to Groq API');

      let response: Response;
      try {
        response = await fetch(GROQ_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${groqApiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'system',
                content:
                  'You are an expert academic linguist and audiobook pronunciation specialist. '
                  + 'You will be given a list of foreign-language terms and must return a JSON object '
                  + 'with a results array following the schema described in the user message. '
                  + 'Respond ONLY with valid JSON — no markdown, no code fences, no extra text.',
              },
              { role: 'user', content: groqObjectPrompt(prompt) },
            ],
            response_format: { type: 'json_object' },
            max_tokens: GROQ_MAX_OUTPUT_TOKENS,
            temperature: 0.1,
          }),
          signal: options.signal,
        });
      } catch (networkErr) {
        options.signal?.throwIfAborted();
        throw networkErr;
      }

      if (response.status === 429) {
        const errorText = await response.text().catch(() => 'HTTP 429');
        const retrySeconds = parseGroqRetryAfter(response, errorText);
        retries429 += 1;

        if (retries429 <= max429Retries) {
          serverLogger.warn({
            event: 'pdf.scan.groq.rate_limit',
            maskedKey,
            model,
            retrySeconds,
            retries429,
            max429Retries,
          }, 'Groq API rate-limited (HTTP 429). Retrying after cooldown');

          if (options.onStatusUpdate) {
            await options.onStatusUpdate(
              `Groq rate limit reached (model ${model}). Waiting ${retrySeconds}s before retrying (Attempt ${retries429}/${max429Retries})…`,
            );
          }

          await sleep(retrySeconds * 1000, options.signal);
          continue;
        }

        lastError = new Error(`Groq rate limit exhausted (HTTP 429): ${errorText.slice(0, 300)}`);
        break; // break out of retry loop to try next model or throw
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => `HTTP ${response.status}`);
        const sanitized = errorText
          .replace(groqApiKey, '[REDACTED]')
          .replace(/[\r\n\t]+/g, ' ')
          .slice(0, 500);

        const modelUnavailable = isGroqModelUnavailable(response.status, errorText);
        const tokenLimitExceeded = response.status === 413;
        const jsonValidationFailed = response.status === 400 && errorText.includes('json_validate_failed');
        if (modelUnavailable || tokenLimitExceeded || jsonValidationFailed) {
          const reason = tokenLimitExceeded ? 'token limit exceeded'
            : jsonValidationFailed ? 'JSON validation failed' : 'model unavailable';
          serverLogger.warn({
            event: 'pdf.scan.groq.model_fallback',
            httpStatus: response.status,
            model,
            maskedKey,
            reason,
          }, 'Groq model could not complete the request; trying fallback model');

          const nextIndex = candidateModels.indexOf(model) + 1;
          const nextModel = candidateModels[nextIndex];
          if (nextModel && options.onStatusUpdate) {
            await options.onStatusUpdate(
              `Groq model ${model}: ${reason}. Switching to fallback model ${nextModel}…`,
            );
          }
          lastError = new Error(`Groq API request failed (HTTP ${response.status}: ${reason}).`);
          break; // break out of 429 loop to try next model in candidateModels
        }

        serverLogger.warn({
          event: 'pdf.scan.groq.error',
          httpStatus: response.status,
          maskedKey,
          error: sanitized,
        }, 'Groq fallback API returned an error response');
        throw new Error(`Groq API request failed (HTTP ${response.status}): ${sanitized}`);
      }

      const data = await response.json().catch(() => null);
      const rawContent: unknown = data?.choices?.[0]?.message?.content;
      if (typeof rawContent !== 'string' || !rawContent.trim()) {
        throw new Error('Groq returned an empty or invalid response.');
      }

      let textToParse = rawContent.trim();
      if (!textToParse.startsWith('[')) {
        try {
          const obj = JSON.parse(textToParse) as Record<string, unknown>;
          const arrayValue = obj?.results;
          if (Array.isArray(arrayValue)) {
            textToParse = JSON.stringify(arrayValue);
          }
        } catch {
          // Fall through to let parseGeminiForeignWordResults handle / throw
        }
      }

      const { results } = parseGeminiForeignWordResults(textToParse);

      serverLogger.info({
        event: 'pdf.scan.groq.success',
        maskedKey,
        model,
        resultCount: results.length,
        inputTokens: data?.usage?.prompt_tokens,
        outputTokens: data?.usage?.completion_tokens,
      }, 'Groq fallback API returned pronunciation results');

      return results;
    }
  }

  throw lastError ?? new Error('All Groq models failed.');
}

/**
 * Sends a foreign-word pronunciation/definition batch to Groq's API.
 * Groq uses an OpenAI-compatible endpoint with json_object response_format and a results wrapper.
 * Automatically chunks candidate terms into sub-batches (~7 terms each)
 * to prevent exceeding Groq free-tier TPM limits (e.g. 8,000 TPM).
 * Returns parsed GeminiForeignWordResult[] on success, throws on error.
 */
export async function fetchGroqForeignWordBatch(
  prompt: string,
  groqApiKey: string,
  signalOrOptions?: AbortSignal | GroqForeignWordOptions,
  legacyModel?: string,
): Promise<GeminiForeignWordResult[]> {
  const options: GroqForeignWordOptions =
    signalOrOptions instanceof AbortSignal
      ? { signal: signalOrOptions, model: legacyModel }
      : typeof signalOrOptions === 'object' && signalOrOptions !== null
      ? { ...signalOrOptions, model: signalOrOptions.model || legacyModel }
      : { model: legacyModel };

  let instructionsPrefix = '';
  let parsedTerms: unknown[] | null = null;
  const termsIndex = prompt.search(/\n+Terms:\s*\n/i);
  if (termsIndex !== -1) {
    const headerMatch = prompt.match(/^([\s\S]*?\n+Terms:\s*\n)([\s\S]*)$/i);
    if (headerMatch) {
      const termsJson = headerMatch[2].trim();
      if (termsJson.startsWith('[') && termsJson.endsWith(']')) {
        try {
          const parsed = JSON.parse(termsJson);
          if (Array.isArray(parsed) && parsed.length > 0) {
            instructionsPrefix = headerMatch[1];
            parsedTerms = parsed;
          }
        } catch {
          // Fall back to sending the raw prompt
        }
      }
    }
  }

  const maxSubBatch = options.maxCandidatesPerSubBatch ?? GROQ_MAX_CANDIDATES_PER_SUB_BATCH;
  if (!parsedTerms || parsedTerms.length <= maxSubBatch) {
    return sendGroqPromptWithFallback(prompt, groqApiKey, options);
  }

  // Chunk candidate terms into sub-batches to comfortably fit under TPM limits
  const allResults: GeminiForeignWordResult[] = [];
  const totalSubBatches = Math.ceil(parsedTerms.length / maxSubBatch);

  for (let b = 0; b < totalSubBatches; b += 1) {
    options.signal?.throwIfAborted();
    const subTerms = parsedTerms.slice(b * maxSubBatch, (b + 1) * maxSubBatch);
    const subPrompt = `${instructionsPrefix}${JSON.stringify(subTerms)}`;

    if (options.onStatusUpdate) {
      await options.onStatusUpdate(
        `Processing Groq sub-batch ${b + 1}/${totalSubBatches} (${subTerms.length} terms)…`,
      );
    }

    const subResults = await sendGroqPromptWithFallback(subPrompt, groqApiKey, options);
    allResults.push(...subResults);

    if (b < totalSubBatches - 1) {
      await sleep(500, options.signal);
    }
  }

  return allResults;
}

/**
 * Convenience helper to send candidate terms with instructions to Groq,
 * chunking into sub-batches as needed.
 */
export async function fetchGroqForeignWordCandidates(
  instructions: string,
  terms: unknown[],
  groqApiKey: string,
  options: GroqForeignWordOptions = {},
): Promise<GeminiForeignWordResult[]> {
  const fullPrompt = `${instructions.trim()}\n\nTerms:\n${JSON.stringify(terms)}`;
  return fetchGroqForeignWordBatch(fullPrompt, groqApiKey, options);
}

/**
 * Returns true when an HTTP status from the Gemini scan route indicates
 * that both Gemini keys have exhausted their billing quota, meaning Groq
 * should be tried next.
 */
export function isGeminiBillingExhausted(
  status: number,
  bodyText: string,
): boolean {
  if (![429, 402, 403].includes(status)) return false;
  const lower = bodyText.toLowerCase();
  return (
    lower.includes('quota')
    || lower.includes('billing')
    || lower.includes('spending cap')
    || lower.includes('prepayment')
    || lower.includes('credits')
  );
}
