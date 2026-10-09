import { sql } from 'drizzle-orm';
import { audiobookJobs } from '@/db/schema';

/** Patch the current database column, never a stale in-memory job snapshot. */
export function mergeJobSettings(patch: Record<string, unknown>) {
  const json = JSON.stringify(patch);
  return (process.env.POSTGRES_URL
    ? sql`coalesce(${audiobookJobs.settingsJson}, '{}'::jsonb) || ${json}::jsonb`
    : sql`json_patch(coalesce(${audiobookJobs.settingsJson}, '{}'), ${json})`) as never;
}

/** An explicit user retry clears the old schedule and starts a fresh budget. */
export function clearRetrySchedule() {
  return (process.env.POSTGRES_URL
    ? sql`coalesce(${audiobookJobs.settingsJson}, '{}'::jsonb) - 'nextAttemptAt' - 'providerRetry' - 'geminiCooldown'`
    : sql`json_remove(coalesce(${audiobookJobs.settingsJson}, '{}'), '$.nextAttemptAt', '$.providerRetry', '$.geminiCooldown')`) as never;
}
