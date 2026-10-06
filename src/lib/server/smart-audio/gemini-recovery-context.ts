import { AsyncLocalStorage } from 'node:async_hooks';
import type { AudiobookGeminiCooldown } from '@/lib/shared/audiobook-gemini-cooldown';
import { serverLogger } from '@/lib/server/logger';

interface GeminiRecoveryContext {
  publish: (cooldown: AudiobookGeminiCooldown | null) => Promise<void>;
  chapterIndex?: number;
}
const context = new AsyncLocalStorage<GeminiRecoveryContext>();

/** Scope nested Gemini calls to one job without changing provider/helper signatures. */
export function withGeminiRecoveryContext<T>(publish: GeminiRecoveryContext['publish'], work: () => Promise<T>): Promise<T> {
  return context.run({ publish }, work);
}

export function setGeminiRecoveryChapter(chapterIndex: number) {
  const current = context.getStore();
  if (current) current.chapterIndex = chapterIndex;
}

export async function publishGeminiRecoveryCooldown(cooldown: AudiobookGeminiCooldown | null) {
  const current = context.getStore();
  if (!current) return;
  try {
    await current.publish(cooldown ? { ...cooldown, chapterIndex: current.chapterIndex } : null);
  } catch (error) {
    // UI persistence must never shorten a provider delay or retry a successful request.
    serverLogger.warn({ event: 'gemini.recovery.status_failed', errorType: error instanceof Error ? error.name : 'UnknownError' },
      'Could not publish Gemini cooldown status');
  }
}
