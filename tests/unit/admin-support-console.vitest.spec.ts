import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { redactSupportDiagnosticText } from '../../src/lib/server/admin/support';

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('admin support console', () => {
  test('is a dedicated full-screen admin route with a Reader sidebar entry', () => {
    const page = source('src/app/(app)/admin/page.tsx');
    const consoleSource = source('src/components/admin/support/SupportConsole.tsx');
    const home = source('src/components/HomeContent.tsx');

    expect(page).toContain('getAuthContext({ headers: await headers() })');
    expect(page).toContain("redirect('/app')");
    expect(consoleSource).toContain('flex h-full min-h-0 w-full');
    expect(consoleSource).toContain('Back to Reader');
    expect(home).toContain("href=\"/admin\"");
    expect(home).toContain('{isAdmin && (');
  });

  test('protects every support API with strict admin authorization', () => {
    const routes = [
      'src/app/api/admin/support/overview/route.ts',
      'src/app/api/admin/support/users/route.ts',
      'src/app/api/admin/support/users/[id]/route.ts',
      'src/app/api/admin/support/users/[id]/credits/route.ts',
      'src/app/api/admin/support/jobs/route.ts',
      'src/app/api/admin/support/jobs/[id]/route.ts',
      'src/app/api/admin/support/payments/route.ts',
      'src/app/api/admin/support/join-requests/route.ts',
      'src/app/api/admin/support/audit/route.ts',
      'src/app/api/admin/support/system/route.ts',
    ];
    for (const route of routes) {
      expect(source(route), route).toContain('requireAdminContext(req)');
    }
  });

  test('redacts credentials and token-bearing URLs from support diagnostics', () => {
    const raw = [
      'Authorization: Bearer secret-token-value',
      'https://reader.test/callback?token=decision-secret&next=1',
      'api_key=provider-secret',
      'gho_abcdefghijklmnopqrstuvwxyz',
    ].join(' ');
    const redacted = redactSupportDiagnosticText(raw);

    expect(redacted).not.toContain('secret-token-value');
    expect(redacted).not.toContain('decision-secret');
    expect(redacted).not.toContain('provider-secret');
    expect(redacted).not.toContain('gho_abcdefghijklmnopqrstuvwxyz');
    expect(redacted).toContain('[redacted]');

    const jsonRedacted = redactSupportDiagnosticText(JSON.stringify({
      api_key: 'json-provider-secret',
      authorization: 'Bearer json-bearer-secret',
    }));
    expect(jsonRedacted).not.toContain('json-provider-secret');
    expect(jsonRedacted).not.toContain('json-bearer-secret');
  });

  test('never sends raw audiobook settings or join decision hashes to the console', () => {
    const support = source('src/lib/server/admin/support.ts');
    const sharedTypes = source('src/lib/shared/admin-support.ts');
    const joinRoute = source('src/app/api/admin/support/join-requests/route.ts');

    expect(support).toContain('function toSupportJob');
    expect(support).not.toContain('settingsJson: row.settingsJson');
    expect(sharedTypes).not.toContain('settingsJson');
    expect(sharedTypes).not.toContain('tokenHash');
    expect(joinRoute).not.toContain('tokenHash');
  });

  test('makes credit retries idempotent and records administrator attribution', () => {
    const quota = source('src/lib/server/access/audiobook-quota.ts');
    const support = source('src/lib/server/admin/support.ts');
    const consoleSource = source('src/components/admin/support/SupportConsole.tsx');

    expect(quota).toContain('ledger.grants.some((grant) => grant.id === input.id)');
    expect(quota).toContain('createdByAdminId');
    expect(support).toContain("action: 'audiobook_credit_grant'");
    expect(support).toContain('Always retry the');
    expect(support).toContain("throw new Error('A reason or payment reference is required.')");
    expect(consoleSource).toContain('grantAttemptRef.current?.signature !== signature');
    expect(consoleSource).toContain('data?.supportPackage.extraAudiobooks');
    expect(consoleSource).toContain('data.supportPackage.minimumUsd');
    expect(consoleSource).toContain("setNote('')");
    expect(consoleSource).not.toContain('crypto.randomUUID()');
  });

  test('keeps reversal debt enforceable and audit history out of runtime settings', () => {
    const quota = source('src/lib/server/access/audiobook-quota.ts');
    const support = source('src/lib/server/admin/support.ts');
    const auditRoute = source('src/app/api/admin/support/audit/route.ts');
    const consoleSource = source('src/components/admin/support/SupportConsole.tsx');

    expect(quota).toContain('outstandingDebt: ledger.outstandingDebt + credits - removedCredits');
    expect(quota).toContain('available: ledger.available + allocation.availableCredits');
    expect(support).toContain('.insert(supportAuditEvents)');
    expect(support).not.toContain('SUPPORT_AUDIT_PREFIX');
    expect(auditRoute).toContain("url.searchParams.get('page')");
    expect(consoleSource).toContain('Page {data.page} of {data.totalPages}');
  });

  test('keeps support summaries and job actions consistent with canonical state', () => {
    const quota = source('src/lib/server/access/audiobook-quota.ts');
    const support = source('src/lib/server/admin/support.ts');
    const consoleSource = source('src/components/admin/support/SupportConsole.tsx');
    const worker = source('src/lib/server/audiobooks/worker.ts');
    const queueRoute = source('src/app/api/audiobooks/queue/route.ts');
    const exportModal = source('src/components/AudiobookExportModal.tsx');

    expect(quota).toContain('getMonthlyAudiobookUsageCounts');
    expect(support).toContain('getMonthlyAudiobookUsageCounts(userIds, monthStart)');
    expect(support).toContain('eq(audiobookJobs.status, current.status)');
    expect(support).toContain("current.status === 'running' ? 'pausing' : 'paused'");
    expect(worker).toContain('AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS');
    expect(worker).toContain('eq(audiobookJobs.status, expectedStatus)');
    expect(worker).toContain('await acknowledgeAudiobookPause(jobId)');
    expect(worker).toContain("eq(audiobookJobs.status, AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS)");
    expect(worker).toContain('if (err instanceof AudiobookJobStoppedError)');
    expect(worker).toContain("await updateClaimedAudiobookJob(job.id, 'running', {");
    expect(queueRoute).toContain('j.status === AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS');
    expect(queueRoute).toContain("inArray(audiobookJobs.status, ['running', AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS])");
    expect(exportModal).toContain('|| j.status === AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS');
    expect(exportModal).toContain('Pause requested. Waiting for the current step to finish...');
    expect(support).toContain('.returning({ id: audiobookJobs.id })');
    expect(support).toContain('recordSupportAudit(auditInput, tx)');
    expect(support).toContain('recordSupportAuditSync(auditInput, tx)');
    expect(support).toContain('Math.min(100, Number(row.progress ?? 0))');
    expect(consoleSource).not.toContain('job.progress * 100');
    expect(consoleSource).toContain('visibleUsers.some((user) => user.id === current)');
    expect(consoleSource).toContain("activeView === 'payments'");
    expect(consoleSource).toContain('reversalShortfall');
    expect(consoleSource).toContain('Pause requested. The worker will stop at its next safe checkpoint.');
  });

  test('integrates Audiobookshelf exports into the admin support console with audit tracking', () => {
    const consoleSource = source('src/components/admin/support/SupportConsole.tsx');
    const uploadRoute = source('src/app/api/audiobook/audiobookshelf/route.ts');
    const matchRoute = source('src/app/api/audiobook/audiobookshelf/match/route.ts');
    const inferRoute = source('src/app/api/audiobook/metadata/infer-title/route.ts');
    const modal = source('src/components/audiobooks/AudiobookshelfModal.tsx');

    expect(consoleSource).toContain("import { AudiobookshelfModal } from '@/components/audiobooks/AudiobookshelfModal'");
    expect(consoleSource).toContain('Push to Audiobookshelf');
    expect(consoleSource).toContain('audiobookshelfJob.documentId');
    expect(consoleSource).toContain('audiobookshelfJob.userId');
    expect(consoleSource).toContain('audiobookshelfTarget.bookId');
    expect(consoleSource).toContain('audiobookshelfTarget.userId');

    expect(modal).toContain('userId?: string');
    expect(modal).toContain('userId: userId || undefined');

    expect(uploadRoute).toContain('recordSupportAudit');
    expect(uploadRoute).toContain("action: 'audiobookshelf_upload'");
    expect(uploadRoute).toContain('ownerUserId');

    expect(matchRoute).toContain('ownerUserId');
    expect(inferRoute).toContain('ownerUserId');
  });
});
