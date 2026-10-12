import type { SmartAudioReviewFlag } from '@/types/document-settings';

/** Failed Director validation uses the same legacy kind; keep those failures visible. */
export function isDramaRecoveryNotice(flag: Pick<SmartAudioReviewFlag, 'kind' | 'reason'>): boolean {
  return ['tts-fallback-used', 'tts-retry-used', 'cloud-tts-split', 'prompt-compacted'].includes(flag.kind ?? '') ||
    flag.kind === 'director-validation-repair' && /^Director output required validation repair \d+\.$/.test(flag.reason ?? '');
}

export function groupDramaRecoveryNotices(flags: readonly SmartAudioReviewFlag[]) {
  const groups = new Map<string, { chapterIndex: number; kind: string; reason: string; count: number }>();
  for (const flag of flags.filter(isDramaRecoveryNotice)) {
    const key = JSON.stringify([flag.chapterIndex, flag.kind, flag.reason]);
    const previous = groups.get(key);
    if (previous) previous.count++;
    else groups.set(key, { chapterIndex: flag.chapterIndex, kind: flag.kind ?? '', reason: flag.reason ?? flag.kind ?? '', count: 1 });
  }
  return [...groups.values()];
}
