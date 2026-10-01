import { describe, expect, test } from 'vitest';
import { explainCharacterScanFailure } from '@/lib/server/audiobooks/character-scan-error';

describe('character scan failure explanations', () => {
  test('explains depleted Gemini prepaid credits without exposing the raw payload', () => {
    const result = explainCharacterScanFailure("402 RESOURCE_EXHAUSTED: {'error': {'message': 'Your prepayment credits are depleted', 'apiKey': 'secret'}}");
    expect(result.code).toBe('GEMINI_CREDITS_DEPLETED');
    expect(result.status).toBe(402);
    expect(result.error).toContain('prepaid credits are depleted');
    expect(result.error).toContain('Google AI Studio');
    expect(result.error).not.toContain('secret');
  });

  test.each([
    ['429 RESOURCE_EXHAUSTED', 'GEMINI_RATE_LIMITED'],
    ['503 service overloaded', 'GEMINI_UNAVAILABLE'],
    ['403 API key not valid', 'GEMINI_AUTH_FAILED'],
    ['unparseable worker response', 'CHARACTER_SCAN_FAILED'],
  ] as const)('classifies %s', (detail, code) => {
    expect(explainCharacterScanFailure(detail).code).toBe(code);
  });
});
