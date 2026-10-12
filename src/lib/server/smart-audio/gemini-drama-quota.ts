import { createHash } from 'node:crypto';
import type { GeminiTtsModel } from './gemini-tts-client';
import { isGeminiTtsModel } from './gemini-tts-client';

export interface GeminiDramaQuotaEntry { credentialHash: string; model: GeminiTtsModel; availableAt: number; statusCode: number }

/** One tracker spans a job's chapters; durable snapshots survive scheduled retries. */
export class GeminiDramaQuotaTracker {
  private readonly entries = new Map<string, GeminiDramaQuotaEntry>();
  constructor(value?: unknown, private readonly now = Date.now,
    private readonly onChange?: (entries: GeminiDramaQuotaEntry[]) => Promise<void>) {
    if (Array.isArray(value)) for (const entry of value) {
      if (entry && typeof entry.credentialHash === 'string' && /^[a-f0-9]{64}$/.test(entry.credentialHash) &&
          isGeminiTtsModel(entry.model) && Number.isFinite(entry.availableAt) && entry.availableAt > now() && entry.statusCode === 429) {
        this.entries.set(`${entry.credentialHash}:${entry.model}`, { credentialHash: entry.credentialHash, model: entry.model, availableAt: entry.availableAt, statusCode: 429 });
      }
    }
  }
  private hash(key: string): string { return createHash('sha256').update(key.trim()).digest('hex'); }
  remaining(key: string, model: GeminiTtsModel): number {
    return Math.max(0, (this.entries.get(`${this.hash(key)}:${model}`)?.availableAt ?? 0) - this.now());
  }
  async defer(key: string, model: GeminiTtsModel, retryAfterMs?: number): Promise<void> {
    const credentialHash = this.hash(key);
    const availableAt = this.now() + Math.max(1000, retryAfterMs ?? 60_000);
    const id = `${credentialHash}:${model}`;
    this.entries.set(id, { credentialHash, model, availableAt: Math.max(availableAt, this.entries.get(id)?.availableAt ?? 0), statusCode: 429 });
    await this.onChange?.(this.snapshot());
  }
  snapshot(): GeminiDramaQuotaEntry[] { return [...this.entries.values()].filter(entry => entry.availableAt > this.now()); }
}
