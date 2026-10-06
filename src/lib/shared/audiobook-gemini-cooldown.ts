export interface AudiobookGeminiCooldown {
  reason: 'rate_limit' | 'unavailable' | 'network';
  model?: string;
  httpStatus?: number;
  startedAt: number;
  retryAt: number;
  serverDirected: boolean;
  chapterIndex?: number;
}

function settings(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return settings(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readAudiobookGeminiCooldown(value: unknown, status: string): AudiobookGeminiCooldown | null {
  if (status !== 'running') return null;
  const raw = settings(settings(value).geminiCooldown);
  if (!['rate_limit', 'unavailable', 'network'].includes(String(raw.reason))
      || typeof raw.startedAt !== 'number' || !Number.isFinite(raw.startedAt)
      || typeof raw.retryAt !== 'number' || !Number.isFinite(raw.retryAt) || raw.retryAt < raw.startedAt
      || raw.retryAt > 8.64e15 || raw.startedAt < 0 || typeof raw.serverDirected !== 'boolean') return null;
  return {
    reason: raw.reason as AudiobookGeminiCooldown['reason'],
    startedAt: raw.startedAt, retryAt: raw.retryAt, serverDirected: raw.serverDirected,
    ...(typeof raw.model === 'string' && /^[a-zA-Z0-9._-]{1,100}$/u.test(raw.model) ? { model: raw.model } : {}),
    ...(typeof raw.httpStatus === 'number' && Number.isInteger(raw.httpStatus) && raw.httpStatus >= 400 && raw.httpStatus <= 599 ? { httpStatus: raw.httpStatus } : {}),
    ...(typeof raw.chapterIndex === 'number' && Number.isInteger(raw.chapterIndex) && raw.chapterIndex >= 0 ? { chapterIndex: raw.chapterIndex } : {}),
  };
}

export function writeAudiobookGeminiCooldown(value: unknown, cooldown: AudiobookGeminiCooldown | null) {
  const result = { ...settings(value) };
  if (cooldown) result.geminiCooldown = cooldown;
  else delete result.geminiCooldown;
  return result;
}

export function formatGeminiCooldownDuration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const s = seconds % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : '', `${s}s`].filter(Boolean).join(' ');
}

export function geminiCooldownExplanation(cooldown: AudiobookGeminiCooldown): string {
  const cause = cooldown.reason === 'rate_limit' ? 'Google Gemini returned a rate limit or quota response'
    : cooldown.reason === 'unavailable' ? 'Google Gemini is temporarily unavailable'
      : 'The connection to Google Gemini failed';
  const details = [cooldown.httpStatus ? `HTTP ${cooldown.httpStatus}` : '', cooldown.model ?? ''].filter(Boolean).join(', ');
  const chapter = cooldown.chapterIndex !== undefined ? ` while processing chapter ${cooldown.chapterIndex + 1}` : '';
  return `${cause}${details ? ` (${details})` : ''}${chapter}. ${cooldown.serverDirected ? 'Google requested' : 'Narratum scheduled'} a ${formatGeminiCooldownDuration(cooldown.retryAt - cooldown.startedAt)} cooldown. Completed chapters and progress are preserved. Generation will retry automatically after this wait.`;
}
