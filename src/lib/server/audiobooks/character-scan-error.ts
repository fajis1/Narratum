export type CharacterScanFailure = {
  code: 'GEMINI_CREDITS_DEPLETED' | 'GEMINI_RATE_LIMITED' | 'GEMINI_UNAVAILABLE' | 'GEMINI_AUTH_FAILED' | 'CHARACTER_SCAN_FAILED';
  error: string;
  status: number;
};

/**
 * Converts provider/worker failures into a safe explanation the character-cast
 * dialog can show directly. Do not pass raw provider payloads to the browser:
 * they may include request metadata or credentials.
 */
export function explainCharacterScanFailure(value: unknown): CharacterScanFailure {
  const detail = String(value ?? '').toLowerCase();
  if (detail.includes('402') || detail.includes('prepayment credits') || detail.includes('credits are depleted')) {
    return {
      code: 'GEMINI_CREDITS_DEPLETED',
      status: 402,
      error: 'Gemini rejected this character scan because the API project’s prepaid credits are depleted. Add credits or enable billing in Google AI Studio for the API key used by this Audio Drama profile, then retry. Your document and OpenReader are still available.',
    };
  }
  if (detail.includes('401') || detail.includes('403') || detail.includes('api key not valid') || detail.includes('permission denied')) {
    return {
      code: 'GEMINI_AUTH_FAILED',
      status: 403,
      error: 'Gemini rejected this character scan because this Audio Drama profile’s API key is missing, invalid, or lacks access to the selected model. Update the key or model in Smart Audio Profiles, then retry.',
    };
  }
  if (detail.includes('503') || detail.includes('overloaded') || detail.includes('unavailable')) {
    return {
      code: 'GEMINI_UNAVAILABLE',
      status: 503,
      error: 'Gemini is temporarily unavailable or overloaded. Wait a few minutes and retry the character scan; your document has not been changed.',
    };
  }
  if (detail.includes('429') || detail.includes('resource_exhausted') || detail.includes('rate limit') || detail.includes('quota')) {
    return {
      code: 'GEMINI_RATE_LIMITED',
      status: 429,
      error: 'Gemini has temporarily rate-limited this character scan. Wait for capacity to reset, or change the configured Gemini model or API key in Smart Audio Profiles, then retry.',
    };
  }
  return {
    code: 'CHARACTER_SCAN_FAILED',
    status: 502,
    error: 'The character scan worker could not complete the request. Your document has not been changed. Check Support Console → System for the redacted diagnostic details, then retry.',
  };
}
