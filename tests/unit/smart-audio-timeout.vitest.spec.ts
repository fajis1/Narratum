import { describe, expect, test } from 'vitest';
import { resolveSmartAudioNatsTimeoutMs } from '../../src/lib/server/audiobooks/smart-audio-timeout';

describe('Smart Audio NATS timeout', () => {
  test('allows longer scholarly cleanup by default', () => {
    expect(resolveSmartAudioNatsTimeoutMs('scholar', undefined)).toBe(600_000);
    expect(resolveSmartAudioNatsTimeoutMs('bibliography-catcher', undefined)).toBe(600_000);
    expect(resolveSmartAudioNatsTimeoutMs('multi-voice', undefined)).toBe(600_000);
  });

  test('keeps standard cleanup at two minutes by default', () => {
    expect(resolveSmartAudioNatsTimeoutMs('standard', undefined)).toBe(120_000);
  });

  test('accepts a bounded environment override', () => {
    expect(resolveSmartAudioNatsTimeoutMs('scholar', '450000')).toBe(450_000);
    expect(resolveSmartAudioNatsTimeoutMs('scholar', '1000')).toBe(30_000);
    expect(resolveSmartAudioNatsTimeoutMs('scholar', '9999999')).toBe(900_000);
    expect(resolveSmartAudioNatsTimeoutMs('scholar', 'invalid')).toBe(600_000);
  });
});
