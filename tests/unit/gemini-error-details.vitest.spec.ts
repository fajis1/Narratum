import { expect, test } from 'vitest';
import { geminiErrorDetails, geminiPrivateErrorDetails } from '@/lib/server/smart-audio/gemini-error-details';

test('retains only allowlisted API details and respects the longer retry hint', async () => {
  const response = Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'private quota message', details: [
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '120.5s' },
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
      { quotaMetric: 'generativelanguage.googleapis.com/generate_content_requests', quotaId: 'private project', description: 'private detail' },
      { quotaMetric: 'https://private.invalid/?key=private' },
    ] },
  ] } }, { status: 429, headers: { 'Retry-After': '30' } });
  const details = await geminiErrorDetails(response);
  expect(details).toEqual({ status: 429, code: 429, apiStatus: 'RESOURCE_EXHAUSTED', retryAfterMs: 120500, quotaMetrics: ['generativelanguage.googleapis.com/generate_content_requests'] });
  expect(JSON.stringify(details)).not.toContain('private');
  expect((await response.json()).error.code).toBe(429);
});

test('handles HTML errors and date headers without inferring a quota type', async () => {
  const now = Date.parse('2026-09-08T00:00:00Z');
  expect(await geminiErrorDetails(new Response('<html>private error</html>', { status: 429, headers: { 'Retry-After': 'Tue, 08 Sep 2026 00:02:00 GMT' } }), now))
    .toEqual({ status: 429, retryAfterMs: 120000 });
});


test('retains bounded BadRequest field violations only in private diagnostics', async () => {
  const response = Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.', details: [
    { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: Array.from({ length: 25 }, () => ({ field: 'generation_config.response_json_schema', description: 'The specified schema produces a constraint that has too many states for serving.' })) },
    { '@type': 'unknown', secret: 'never retain' },
  ] } }, { status: 400 });
  const privateDetails = await geminiPrivateErrorDetails(response);
  expect(privateDetails.fieldViolations).toHaveLength(20);
  expect(privateDetails.fieldViolations![0].description).toContain('too many states');
  expect(await geminiErrorDetails(response)).not.toHaveProperty('fieldViolations');
  expect(JSON.stringify(privateDetails)).not.toContain('never retain');
});
