export const GEMINI_VOICE_AUDITION_URL = 'https://aistudio.google.com/generate-speech?model=gemini-3.8-flash-tts';
const CONSENT_KEY = 'narratum:gemini-tts-preview-quota-ack:v1';

/** Remember acknowledgement for this browser tab; unavailable storage fails closed. */
export function hasAcknowledgedGeminiPreviewQuota(): boolean {
  try { return window.sessionStorage.getItem(CONSENT_KEY) === 'true'; } catch { return false; }
}

export function acknowledgeGeminiPreviewQuota(): void {
  try { window.sessionStorage.setItem(CONSENT_KEY, 'true'); } catch { /* The mounted dialog also retains acknowledgement. */ }
}
