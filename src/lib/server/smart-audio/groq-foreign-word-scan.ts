import { serverLogger } from '@/lib/server/logger';
import type { GeminiForeignWordResult } from './gemini-foreign-word-scan';
import { parseGeminiForeignWordResults } from './gemini-foreign-word-scan';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_DEFAULT_MODEL = 'llama-3.3-70b-versatile';

/**
 * Sends a foreign-word pronunciation/definition batch to Groq's free-tier API.
 * Groq uses an OpenAI-compatible endpoint with json_object response_format.
 * The caller-supplied prompt is used verbatim as the user message content.
 * Returns parsed GeminiForeignWordResult[] on success, throws on error.
 */
export async function fetchGroqForeignWordBatch(
  prompt: string,
  groqApiKey: string,
  signal?: AbortSignal,
): Promise<GeminiForeignWordResult[]> {
  const maskedKey = groqApiKey.length >= 4 ? `...${groqApiKey.slice(-4)}` : 'Key';

  serverLogger.info({
    event: 'pdf.scan.groq.request',
    maskedKey,
    model: GROQ_DEFAULT_MODEL,
  }, 'Sending foreign-word batch to Groq fallback API');

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${groqApiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_DEFAULT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert academic linguist and audiobook pronunciation specialist. '
            + 'You will be given a list of foreign-language terms and must return a JSON array '
            + 'following the exact schema described in the user message. '
            + 'Respond ONLY with valid JSON — no markdown, no code fences, no extra text.',
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 8192,
      temperature: 0.1,
    }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => `HTTP ${response.status}`);
    const sanitized = errorText
      .replace(groqApiKey, '[REDACTED]')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 500);
    serverLogger.warn({
      event: 'pdf.scan.groq.error',
      httpStatus: response.status,
      maskedKey,
      error: sanitized,
    }, 'Groq fallback API returned an error response');
    throw new Error(`Groq API request failed (HTTP ${response.status}): ${sanitized}`);
  }

  const data = await response.json().catch(() => null);
  // Groq returns choices[0].message.content as a JSON string (json_object mode)
  const rawContent: unknown = data?.choices?.[0]?.message?.content;
  if (typeof rawContent !== 'string' || !rawContent.trim()) {
    throw new Error('Groq returned an empty or invalid response.');
  }

  // Groq json_object mode wraps arrays in {"items":[...]} or similar.
  // Try the content directly first; if it's an object, look for an array value.
  let textToParse = rawContent.trim();
  if (!textToParse.startsWith('[')) {
    // Find the first array value in the object
    try {
      const obj = JSON.parse(textToParse) as Record<string, unknown>;
      const arrayValue = Object.values(obj).find(Array.isArray);
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
    model: GROQ_DEFAULT_MODEL,
    resultCount: results.length,
    inputTokens: data?.usage?.prompt_tokens,
    outputTokens: data?.usage?.completion_tokens,
  }, 'Groq fallback API returned pronunciation results');

  return results;
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
  if (status !== 429) return false;
  const lower = bodyText.toLowerCase();
  return (
    lower.includes('quota')
    || lower.includes('billing')
    || lower.includes('spending cap')
    || lower.includes('prepayment')
    || lower.includes('credits')
  );
}
