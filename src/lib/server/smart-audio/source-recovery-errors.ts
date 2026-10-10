import type { SourceRecoveryStage } from '@/types/source-recovery';

/** Fixed public messages only. Causes/stderr may contain paths or document data. */
export class SourceRecoveryStageError extends Error {
  constructor(public readonly stage: SourceRecoveryStage, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'SourceRecoveryStageError';
  }
}
