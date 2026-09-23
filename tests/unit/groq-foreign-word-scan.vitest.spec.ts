import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  GROQ_DEFAULT_MODEL,
  GROQ_FALLBACK_MODELS,
  GROQ_MAX_CANDIDATES_PER_SUB_BATCH,
  GROQ_MAX_OUTPUT_TOKENS,
  fetchGroqForeignWordBatch,
  fetchGroqForeignWordCandidates,
  parseGroqRetryAfter,
  isGroqModelUnavailable,
  isGeminiBillingExhausted,
} from '@/lib/server/smart-audio/groq-foreign-word-scan';

describe('groq-foreign-word-scan', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  describe('configuration and constants', () => {
    it('defaults to openai/gpt-oss-20b for high TPM and low latency', () => {
      expect(GROQ_DEFAULT_MODEL).toBe('openai/gpt-oss-20b');
      expect(GROQ_FALLBACK_MODELS).toContain('openai/gpt-oss-120b');
      expect(GROQ_MAX_CANDIDATES_PER_SUB_BATCH).toBe(7);
      expect(GROQ_MAX_OUTPUT_TOKENS).toBeLessThan(8192);
    });
  });

  describe('parseGroqRetryAfter', () => {
    it('parses Retry-After header correctly', () => {
      const res = new Response(null, { headers: { 'retry-after': '4' } });
      expect(parseGroqRetryAfter(res, '')).toBe(4);
    });

    it('parses x-ratelimit-reset-tokens header correctly', () => {
      const res = new Response(null, { headers: { 'x-ratelimit-reset-tokens': '2.34s' } });
      expect(parseGroqRetryAfter(res, '')).toBe(3);
    });

    it('parses duration from Groq rate-limit body message', () => {
      const res = new Response(null);
      const body = JSON.stringify({
        error: {
          message: 'Rate limit reached for model on TPM. Please try again in 3.45s.',
          type: 'tokens',
        },
      });
      expect(parseGroqRetryAfter(res, body)).toBe(4);
    });

    it('falls back to 5s if no duration is found', () => {
      const res = new Response(null);
      expect(parseGroqRetryAfter(res, 'unknown error')).toBe(5);
    });

    it('caps retry delay at 60 seconds', () => {
      const res = new Response(null, { headers: { 'retry-after': '120' } });
      expect(parseGroqRetryAfter(res, '')).toBe(60);
    });
  });

  describe('isGroqModelUnavailable', () => {
    it('identifies 404 and model not found errors as unavailable', () => {
      expect(isGroqModelUnavailable(404, 'Not Found')).toBe(true);
      expect(isGroqModelUnavailable(400, 'model_not_found')).toBe(true);
      expect(isGroqModelUnavailable(400, 'The model `foo` does not exist')).toBe(true);
      expect(isGroqModelUnavailable(400, 'decommissioned model')).toBe(true);
      expect(isGroqModelUnavailable(429, 'rate limit exceeded')).toBe(false);
      expect(isGroqModelUnavailable(500, 'internal server error')).toBe(false);
    });
  });

  describe('isGeminiBillingExhausted', () => {
    it('identifies 429 quota exhaustion messages', () => {
      expect(isGeminiBillingExhausted(429, 'quota exceeded')).toBe(true);
      expect(isGeminiBillingExhausted(429, 'spending cap reached')).toBe(true);
      expect(isGeminiBillingExhausted(429, 'rate limit')).toBe(false);
      expect(isGeminiBillingExhausted(500, 'quota exceeded')).toBe(false);
    });
  });

  describe('fetchGroqForeignWordBatch candidate sub-batching', () => {
    it('chunks 15 candidate terms into sub-batches of 7 and merges all results', async () => {
      const terms = Array.from({ length: 15 }, (_, i) => ({
        term: `word_${i + 1}`,
        contexts: [`Context sentence for word_${i + 1}`],
      }));

      const prompt = `Linguistic instructions here.\n\nTerms:\n${JSON.stringify(terms)}`;
      const statusUpdates: string[] = [];

      const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.response_format).toEqual({ type: 'json_object' });
        expect(body.max_tokens).toBe(GROQ_MAX_OUTPUT_TOKENS);
        expect(body.messages[0].content).toContain('JSON object');
        expect(body.messages[1].content).toContain('{"results":[...]}');
        const userContent = body.messages?.[1]?.content || '';
        const match = userContent.match(/Terms:\n([\s\S]*)$/);
        const subTerms = match ? JSON.parse(match[1]) : [];

        const generated = subTerms.map((t: { term: string }) => ({
          term: t.term,
          language: 'koine_greek',
          pronunciations: ['ipa-one', 'ipa-two'],
          definition: `Definition of ${t.term}`,
        }));

        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({ results: generated }),
            },
          }],
          usage: { prompt_tokens: 1500, completion_tokens: 200 },
        }), { status: 200 });
      });

      global.fetch = mockFetch as unknown as typeof fetch;

      const results = await fetchGroqForeignWordBatch(prompt, 'gsk_testkey1234', {
        onStatusUpdate: (msg) => { statusUpdates.push(msg); },
      });

      // 15 terms with maxSubBatch = 7 -> 3 sub-batches (7 + 7 + 1)
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(results).toHaveLength(15);
      expect(results[0].term).toBe('word_1');
      expect(results[14].term).toBe('word_15');
      expect(statusUpdates).toEqual([
        'Processing Groq sub-batch 1/3 (7 terms)…',
        'Processing Groq sub-batch 2/3 (7 terms)…',
        'Processing Groq sub-batch 3/3 (1 terms)…',
      ]);
    });

    it('sends a single request when terms count is <= 7', async () => {
      const terms = [
        { term: 'logos', contexts: ['In the beginning was the Word'] },
        { term: 'theos', contexts: ['and the Word was with God'] },
      ];
      const prompt = `Instructions.\n\nTerms:\n${JSON.stringify(terms)}`;

      const mockFetch = vi.fn(async () => new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify([
              { term: 'logos', language: 'koine_greek', pronunciations: ['ˈlo.ɣos'], definition: 'word' },
              { term: 'theos', language: 'koine_greek', pronunciations: ['θeˈos'], definition: 'God' },
            ]),
          },
        }],
      }), { status: 200 }));

      global.fetch = mockFetch as unknown as typeof fetch;

      const results = await fetchGroqForeignWordBatch(prompt, 'gsk_testkey');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(2);
    });

    it('handles unstructured prompts without Terms JSON block as a single request', async () => {
      const prompt = 'Please translate these miscellaneous terms.';

      const mockFetch = vi.fn(async () => new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify([
              { term: 'shalom', language: 'biblical_hebrew', pronunciations: ['ʃaˈlom'], definition: 'peace' },
            ]),
          },
        }],
      }), { status: 200 }));

      global.fetch = mockFetch as unknown as typeof fetch;

      const results = await fetchGroqForeignWordBatch(prompt, 'gsk_testkey');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(results[0].term).toBe('shalom');
    });

    it('retries on HTTP 429 TPM rate limits with retry-after cooldown', async () => {
      let attempts = 0;
      const statusUpdates: string[] = [];
      const mockFetch = vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(JSON.stringify({
            error: { message: 'Rate limit reached on TPM. Please try again in 2.5s.' },
          }), {
            status: 429,
            headers: { 'retry-after': '3' },
          });
        }
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify([
                { term: 'agape', language: 'koine_greek', pronunciations: ['aˈɣa.pi'], definition: 'love' },
              ]),
            },
          }],
        }), { status: 200 });
      });

      global.fetch = mockFetch as unknown as typeof fetch;

      const results = await fetchGroqForeignWordBatch('Translate agape', 'gsk_testkey', {
        onStatusUpdate: (msg) => { statusUpdates.push(msg); },
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(results[0].term).toBe('agape');
      expect(statusUpdates.some((s) => s.includes('Groq rate limit reached'))).toBe(true);
    });

    it('falls back to secondary model when primary model returns 404', async () => {
      const modelsCalled: string[] = [];
      const statusUpdates: string[] = [];

      const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}'));
        modelsCalled.push(body.model);

        if (body.model === 'openai/gpt-oss-20b') {
          return new Response(JSON.stringify({
            error: { message: 'The model openai/gpt-oss-20b does not exist', code: 'model_not_found' },
          }), { status: 404 });
        }

        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify([
                { term: 'pneuma', language: 'koine_greek', pronunciations: ['ˈpnef.ma'], definition: 'spirit' },
              ]),
            },
          }],
        }), { status: 200 });
      });

      global.fetch = mockFetch as unknown as typeof fetch;

      const results = await fetchGroqForeignWordBatch('Translate pneuma', 'gsk_testkey', {
        onStatusUpdate: (msg) => { statusUpdates.push(msg); },
      });

      expect(modelsCalled).toEqual(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
      expect(results[0].term).toBe('pneuma');
      expect(statusUpdates.some((s) => s.includes('unavailable. Switching to fallback model'))).toBe(true);
    });

    it.each([400, 413])('tries the next model after HTTP %i output-shape or request-size errors', async (status) => {
      const models: string[] = [];
      global.fetch = vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'));
        models.push(body.model);
        if (models.length === 1) return new Response(JSON.stringify({
          error: { code: status === 400 ? 'json_validate_failed' : 'rate_limit_exceeded', failed_generation: '' },
        }), { status });
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          results: [{ term: 'λόγος', language: 'koine_greek', pronunciations: ['/loɡos/'], definition: 'word' }],
        }) } }] }), { status: 200 });
      }) as typeof fetch;
      const results = await fetchGroqForeignWordBatch('Translate λόγος', 'gsk_testkey', { fallbackModels: ['openai/gpt-oss-120b'] });
      expect(models).toEqual(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
      expect(results[0].term).toBe('λόγος');
    });

    it('aborts cleanly when AbortSignal is triggered', async () => {
      const controller = new AbortController();
      controller.abort();

      const terms = Array.from({ length: 14 }, (_, i) => ({ term: `t_${i}` }));
      const prompt = `Terms:\n${JSON.stringify(terms)}`;

      await expect(
        fetchGroqForeignWordBatch(prompt, 'gsk_testkey', { signal: controller.signal }),
      ).rejects.toThrow();
    });

    it('fetchGroqForeignWordCandidates helper builds prompt and returns results', async () => {
      const mockFetch = vi.fn(async () => new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify([
              { term: 'charis', language: 'koine_greek', pronunciations: ['ˈça.ris'], definition: 'grace' },
            ]),
          },
        }],
      }), { status: 200 }));

      global.fetch = mockFetch as unknown as typeof fetch;

      const results = await fetchGroqForeignWordCandidates(
        'Generate IPA',
        [{ term: 'charis' }],
        'gsk_testkey',
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(results[0].term).toBe('charis');
    });
  });
});
