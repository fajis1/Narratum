'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import toast from 'react-hot-toast';
import { Button, Input, SidebarNavItem, cn } from '@/components/ui';
import { AudiobookshelfModal } from '@/components/audiobooks/AudiobookshelfModal';
import type {
  AdminSupportView,
  SupportAuditResponse,
  SupportJob,
  SupportJobsResponse,
  SupportJoinRequest,
  SupportOverview,
  SupportPaymentsResponse,
  SupportUserDetail,
  SupportUsersResponse,
} from '@/lib/shared/admin-support';

const VIEWS: Array<{ id: AdminSupportView; label: string; description: string; icon: string }> = [
  { id: 'overview', label: 'Overview', description: 'Workload and attention items', icon: '◫' },
  { id: 'users', label: 'Users', description: 'Accounts, quotas, and credits', icon: '◎' },
  { id: 'jobs', label: 'Audiobook jobs', description: 'Queue and failures', icon: '◉' },
  { id: 'payments', label: 'Payments', description: 'PayPal credits and reversals', icon: '$' },
  { id: 'requests', label: 'Join requests', description: 'Approve access requests', icon: '◇' },
  { id: 'system', label: 'System', description: 'Tasks and diagnostic logs', icon: '⌁' },
  { id: 'audit', label: 'Audit log', description: 'Administrator actions', icon: '≡' },
];

const fetcher = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
};

function isSupportView(value: string | null): value is AdminSupportView {
  return VIEWS.some((view) => view.id === value);
}

function createPortableIdempotencyKey(): string {
  return `support-grant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function formatDate(value: number | null | undefined): string {
  if (!value) return 'Never';
  return new Date(value).toLocaleString();
}

function formatShortDate(value: number | null | undefined): string {
  if (!value) return 'Never';
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRelative(value: number | null | undefined): string {
  if (!value) return 'Never';
  const elapsed = Math.max(0, Date.now() - value);
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return formatShortDate(value);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / (1024 ** power);
  return `${amount >= 10 || power === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[power]}`;
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

function humanizeAction(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusTone(status: string): string {
  if (['error', 'failed', 'review_required', 'refunded', 'reversed'].includes(status)) {
    return 'border-danger bg-danger-wash text-danger';
  }
  if (status === 'running') return 'border-accent-line bg-accent-wash text-accent';
  if (status === 'pausing') return 'border-warning/40 bg-warning/10 text-foreground';
  if (status === 'completed' || status === 'approved' || status === 'ok') {
    return 'border-accent-line bg-accent-wash text-accent';
  }
  if (status === 'paused' || status === 'denied') return 'border-line bg-surface-sunken text-soft';
  return 'border-line bg-surface-sunken text-foreground';
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize', statusTone(status))}>
      {status.replaceAll('_', ' ')}
    </span>
  );
}

function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-xl border border-line bg-surface text-sm text-soft" aria-busy="true">
      {label}
    </div>
  );
}

function ErrorBlock({ error }: { error: unknown }) {
  return (
    <div className="rounded-xl border border-danger bg-danger-wash p-4 text-sm text-danger">
      {error instanceof Error ? error.message : 'Unable to load support data.'}
    </div>
  );
}

function EmptyBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-surface-sunken p-8 text-center text-sm text-soft">
      {children}
    </div>
  );
}

function PanelHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-soft">{description}</p>
      </div>
      {actions}
    </div>
  );
}

function StatCard({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-soft">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      <p className="mt-1 text-xs text-soft">{detail}</p>
    </div>
  );
}

export function SupportConsole() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedView = searchParams.get('view');
  const activeView: AdminSupportView = isSupportView(requestedView) ? requestedView : 'overview';

  const navigate = (view: AdminSupportView) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', view);
    router.replace(`/admin?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-4 lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" className="h-8 w-8 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-foreground">Support Console</h1>
            <p className="hidden text-xs text-soft sm:block">OpenReader administration and user support</p>
          </div>
        </div>
        <Link
          href="/app"
          className="inline-flex h-8 items-center rounded-md border border-line bg-surface-sunken px-3 text-sm font-medium text-foreground hover:border-accent-line hover:bg-accent-wash hover:text-accent"
        >
          ← Back to Reader
        </Link>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface p-3 md:flex">
          <div className="mb-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-soft">
            Administration
          </div>
          <nav className="flex flex-col gap-1" aria-label="Support console">
            {VIEWS.map((view) => (
              <SidebarNavItem
                key={view.id}
                active={activeView === view.id}
                onClick={() => navigate(view.id)}
                icon={<span className="text-sm" aria-hidden="true">{view.icon}</span>}
                label={(
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{view.label}</span>
                    <span className="truncate text-[10px] font-normal text-soft">{view.description}</span>
                  </span>
                )}
                className="py-2"
              />
            ))}
          </nav>
          <div className="mt-auto rounded-lg border border-line bg-surface-sunken p-3 text-xs text-soft">
            Support views expose operational metadata only. Document text and account credentials remain private.
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-surface px-3 py-2 md:hidden">
            {VIEWS.map((view) => (
              <Button
                key={view.id}
                size="sm"
                variant={activeView === view.id ? 'primary' : 'ghost'}
                onClick={() => navigate(view.id)}
                className="shrink-0"
              >
                {view.label}
              </Button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
            {activeView === 'overview' && <OverviewPanel onNavigate={navigate} />}
            {activeView === 'users' && <UsersPanel />}
            {activeView === 'jobs' && <JobsPanel />}
            {activeView === 'payments' && <PaymentsPanel />}
            {activeView === 'requests' && <JoinRequestsPanel />}
            {activeView === 'system' && <SystemPanel />}
            {activeView === 'audit' && <AuditPanel />}
          </div>
        </main>
      </div>
    </div>
  );
}

function OverviewPanel({ onNavigate }: { onNavigate: (view: AdminSupportView) => void }) {
  const { data, error, isLoading, mutate } = useSWR<SupportOverview>(
    '/api/admin/support/overview',
    fetcher,
    { refreshInterval: 15_000 },
  );
  if (isLoading) return <LoadingBlock label="Loading support overview…" />;
  if (error || !data) return <ErrorBlock error={error} />;
  return (
    <div className="space-y-6">
      <PanelHeading
        title="Overview"
        description="A quick view of workload, users, and anything needing attention."
        actions={<Button size="sm" onClick={() => mutate()}>Refresh</Button>}
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatCard label="Users" value={data.userCount} detail="Registered accounts" />
        <StatCard label="Documents" value={data.documentCount} detail="Across all users" />
        <StatCard label="Audiobooks" value={data.audiobookCount} detail="Created libraries" />
        <StatCard label="Active jobs" value={data.activeJobCount} detail="Queued or processing" />
        <StatCard label="Failed jobs" value={data.failedJobCount} detail="May need support" />
        <StatCard label="Join requests" value={data.pendingRequestCount} detail="Awaiting a decision" />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <section className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="font-semibold text-foreground">Recent failed audiobook jobs</h3>
            <Button size="xs" variant="ghost" onClick={() => onNavigate('jobs')}>View all</Button>
          </div>
          {data.recentFailures.length === 0 ? (
            <EmptyBlock>No failed jobs.</EmptyBlock>
          ) : (
            <div className="space-y-2">
              {data.recentFailures.map((job) => (
                <div key={job.id} className="rounded-lg border border-line bg-surface-sunken p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{job.documentTitle}</p>
                      <p className="truncate text-xs text-soft">{job.userEmail} · {formatRelative(job.updatedAt)}</p>
                    </div>
                    <StatusBadge status={job.status} />
                  </div>
                  {job.error && <p className="mt-2 line-clamp-2 text-xs text-danger">{job.error}</p>}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="font-semibold text-foreground">Recent administrator actions</h3>
            <Button size="xs" variant="ghost" onClick={() => onNavigate('audit')}>View all</Button>
          </div>
          {data.recentAudit.length === 0 ? (
            <EmptyBlock>No support actions recorded yet.</EmptyBlock>
          ) : (
            <div className="divide-y divide-line">
              {data.recentAudit.map((event) => (
                <div key={event.id} className="py-2.5 first:pt-0 last:pb-0">
                  <p className="text-sm font-medium text-foreground">{humanizeAction(event.action)}</p>
                  <p className="text-xs text-soft">
                    {event.amount ? `${event.amount > 0 ? '+' : ''}${event.amount} credits · ` : ''}
                    {formatRelative(event.createdAt)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function UsersPanel() {
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setQuery(searchInput.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  const usersKey = `/api/admin/support/users?q=${encodeURIComponent(query)}&page=${page}&pageSize=30`;
  const { data, error, isLoading, mutate } = useSWR<SupportUsersResponse>(usersKey, fetcher);
  useEffect(() => {
    const visibleUsers = data?.users || [];
    setSelectedUserId((current) => (
      current && visibleUsers.some((user) => user.id === current)
        ? current
        : visibleUsers[0]?.id || null
    ));
  }, [data]);

  return (
    <div className="flex min-h-full flex-col gap-5">
      <PanelHeading
        title="Users"
        description="Search accounts, inspect usage, grant support credits, and troubleshoot recent jobs."
        actions={<Button size="sm" onClick={() => mutate()}>Refresh</Button>}
      />
      <div className="grid min-h-[640px] flex-1 gap-4 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,2.2fr)]">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface">
          <div className="border-b border-line p-3">
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search name or email…"
              aria-label="Search users"
            />
            <p className="mt-2 text-xs text-soft">{data?.total ?? 0} matching users</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {isLoading && !data ? <LoadingBlock label="Loading users…" /> : null}
            {error ? <ErrorBlock error={error} /> : null}
            {data?.users.length === 0 ? <EmptyBlock>No users match this search.</EmptyBlock> : null}
            <div className="space-y-1">
              {data?.users.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => setSelectedUserId(user.id)}
                  className={cn(
                    'w-full rounded-lg border p-3 text-left',
                    selectedUserId === user.id
                      ? 'border-accent-line bg-accent-wash'
                      : 'border-transparent hover:border-line hover:bg-surface-sunken',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">{user.name}</p>
                      <p className="truncate text-xs text-soft">{user.email}</p>
                    </div>
                    {user.isAdmin ? <StatusBadge status="admin" /> : null}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-soft">
                    <span>{user.documentCount} docs</span>
                    <span>{user.audiobookCount} audiobooks</span>
                    <span>{user.quota.unlimited ? 'Unlimited' : `${user.quota.totalRemaining} available`}</span>
                    {user.failedJobCount > 0 ? <span className="text-danger">{user.failedJobCount} failed</span> : null}
                  </div>
                  <p className="mt-1.5 text-[11px] text-soft">Active {formatRelative(user.lastActiveAt)}</p>
                </button>
              ))}
            </div>
          </div>
          {data && data.totalPages > 1 ? (
            <div className="flex items-center justify-between border-t border-line p-3 text-xs text-soft">
              <Button size="xs" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button>
              <span>Page {data.page} of {data.totalPages}</span>
              <Button size="xs" disabled={page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>Next</Button>
            </div>
          ) : null}
        </section>
        <UserDetailPanel userId={selectedUserId} onChanged={() => mutate()} />
      </div>
    </div>
  );
}

function UserDetailPanel({ userId, onChanged }: { userId: string | null; onChanged: () => void }) {
  const key = userId ? `/api/admin/support/users/${encodeURIComponent(userId)}` : null;
  const { data, error, isLoading, mutate } = useSWR<SupportUserDetail>(key, fetcher);
  const [credits, setCredits] = useState(1);
  const [note, setNote] = useState('');
  const [granting, setGranting] = useState(false);
  const [audiobookshelfTarget, setAudiobookshelfTarget] = useState<{
    bookId: string;
    userId: string;
    title: string;
    documentType?: string;
  } | null>(null);
  const grantAttemptRef = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    setCredits(data?.supportPackage.extraAudiobooks ?? 1);
    setNote('');
    grantAttemptRef.current = null;
  }, [data?.supportPackage.extraAudiobooks, userId]);

  if (!userId) return <EmptyBlock>Select a user to inspect their account.</EmptyBlock>;
  if (isLoading || !data) return error ? <ErrorBlock error={error} /> : <LoadingBlock label="Loading user details…" />;

  const grantCredits = async () => {
    if (!note.trim()) {
      toast.error('Add a reason or payment reference for the audit log.');
      return;
    }
    if (!Number.isFinite(credits) || credits < 1 || credits > 1000) {
      toast.error('Credits must be between 1 and 1000.');
      return;
    }
    setGranting(true);
    try {
      const signature = JSON.stringify([userId, credits, note.trim()]);
      if (grantAttemptRef.current?.signature !== signature) {
        grantAttemptRef.current = { signature, key: createPortableIdempotencyKey() };
      }
      const response = await fetch(`/api/admin/support/users/${encodeURIComponent(userId)}/credits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credits,
          note: note.trim(),
          idempotencyKey: grantAttemptRef.current.key,
        }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || 'Unable to grant credits.');
      const debtOffset = Math.min(data.creditHistory.outstandingDebt, credits);
      const availableCredits = credits - debtOffset;
      toast.success(debtOffset > 0
        ? `${availableCredits} credit${availableCredits === 1 ? '' : 's'} added; ${debtOffset} settled reversal debt.`
        : `Granted ${credits} audiobook credit${credits === 1 ? '' : 's'}.`);
      grantAttemptRef.current = null;
      setNote('');
      await mutate();
      onChanged();
    } catch (grantError) {
      toast.error(grantError instanceof Error ? grantError.message : 'Unable to grant credits.');
    } finally {
      setGranting(false);
    }
  };

  const { user } = data;
  const creditEvents = [
    ...data.creditHistory.grants.map((grant) => ({
      id: grant.id,
      amount: grant.credits - grant.debtOffset,
      createdAt: grant.createdAt,
      detail: `${grant.note || 'No note provided'}${grant.debtOffset > 0
        ? ` · ${grant.debtOffset} of ${grant.credits} credits applied to reversal debt`
        : ''}`,
    })),
    ...data.creditHistory.consumptions.map((consumption) => ({
      id: consumption.id,
      amount: -1,
      createdAt: consumption.createdAt,
      detail: `Used by audiobook job ${consumption.jobId}`,
    })),
    ...data.creditHistory.revocations.map((revocation) => ({
      id: revocation.id,
      amount: -revocation.removedCredits,
      createdAt: revocation.createdAt,
      detail: `${revocation.note || 'Credits revoked'}${revocation.credits > revocation.removedCredits
        ? ` · ${revocation.credits - revocation.removedCredits} already-used credits could not be removed`
        : ''}`,
    })),
  ].sort((left, right) => right.createdAt - left.createdAt);
  return (
    <section className="min-h-0 overflow-y-auto rounded-xl border border-line bg-surface">
      <div className="border-b border-line p-4 lg:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-xl font-semibold text-foreground">{user.name}</h3>
              {user.isAdmin ? <StatusBadge status="admin" /> : null}
            </div>
            <p className="truncate text-sm text-soft">{user.email}</p>
            <p className="mt-1 text-xs text-soft">
              Joined {formatShortDate(user.createdAt)} · Last active {formatRelative(user.lastActiveAt)}
            </p>
          </div>
          <Button size="sm" onClick={() => mutate()}>Refresh user</Button>
        </div>
      </div>

      <div className="space-y-5 p-4 lg:p-5">
        <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
          <StatCard label="Free books" value={user.quota.unlimited ? 'Unlimited' : `${user.quota.freeRemaining} left`} detail={user.quota.unlimited ? 'Administrator account' : `${user.quota.freeUsed} of ${user.quota.freeLimit} used`} />
          <StatCard
            label="Support credits"
            value={user.quota.supportCreditsRemaining}
            detail={data.creditHistory.outstandingDebt > 0
              ? `${data.creditHistory.outstandingDebt} reversal debt outstanding`
              : 'Persistent until used'}
          />
          <StatCard label="Documents" value={user.documentCount} detail={formatBytes(user.storageBytes)} />
          <StatCard label="Jobs needing help" value={user.failedJobCount} detail={`${user.activeJobCount} currently active`} />
        </div>

        <section className="rounded-xl border border-line bg-surface-sunken p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="font-semibold text-foreground">Grant audiobook credits</h4>
              <p className="mt-1 text-xs text-soft">
                The configured {formatMoney(data.supportPackage.minimumUsd * 100, 'USD')} support package grants{' '}
                {data.supportPackage.extraAudiobooks} additional audiobook{data.supportPackage.extraAudiobooks === 1 ? '' : 's'}.
              </p>
            </div>
            {user.isAdmin ? <span className="text-xs text-soft">Administrators already have unlimited generation.</span> : null}
          </div>
          {data.creditHistory.outstandingDebt > 0 ? (
            <p className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
              This account has {data.creditHistory.outstandingDebt} credit{data.creditHistory.outstandingDebt === 1 ? '' : 's'} of reversal debt. New support or administrator grants settle that debt before adding usable books.
            </p>
          ) : null}
          <div className="mt-3 grid gap-2 md:grid-cols-[120px_minmax(220px,1fr)_auto]">
            <Input
              type="number"
              min={1}
              max={1000}
              value={credits}
              onChange={(event) => setCredits(Number(event.target.value))}
              aria-label="Number of audiobook credits"
              disabled={granting || user.isAdmin}
            />
            <Input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Reason or payment reference (required)"
              aria-label="Credit grant reason"
              disabled={granting || user.isAdmin}
            />
            <Button variant="primary" onClick={grantCredits} disabled={granting || user.isAdmin}>
              {granting ? 'Granting…' : `Grant ${credits || 0}`}
            </Button>
          </div>
        </section>

        <section>
          <h4 className="mb-2 font-semibold text-foreground">Recent audiobook jobs</h4>
          {data.recentJobs.length === 0 ? (
            <EmptyBlock>This user has no audiobook jobs.</EmptyBlock>
          ) : (
            <div className="space-y-2">
              {data.recentJobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  onChanged={() => mutate()}
                  onPushToAudiobookshelf={() => setAudiobookshelfTarget({
                    bookId: job.documentId,
                    userId: job.userId,
                    title: job.documentTitle,
                  })}
                />
              ))}
            </div>
          )}
        </section>

        <div className="grid gap-5 2xl:grid-cols-2">
          <section>
            <h4 className="mb-2 font-semibold text-foreground">Recent documents</h4>
            {data.recentDocuments.length === 0 ? (
              <EmptyBlock>No documents uploaded.</EmptyBlock>
            ) : (
              <div className="overflow-hidden rounded-xl border border-line">
                <div className="divide-y divide-line">
                  {data.recentDocuments.map((document) => {
                    const completedJob = data.recentJobs.find(
                      (j) => j.documentId === document.id && j.status === 'completed',
                    );
                    return (
                      <div key={document.id} className="flex items-center justify-between gap-4 bg-surface-sunken px-3 py-2.5">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{document.name}</p>
                          <p className="text-xs uppercase text-soft">{document.type}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {completedJob && (
                            <Button
                              size="xs"
                              variant="ghost"
                              className="text-xs h-7 px-2 border border-line bg-surface hover:bg-accent-wash hover:text-accent hover:border-accent-line"
                              onClick={() => setAudiobookshelfTarget({
                                bookId: document.id,
                                userId: user.id,
                                title: completedJob.documentTitle || document.name.replace(/\.[^/.]+$/, ''),
                                documentType: document.type,
                              })}
                              title="Push completed audiobook to Audiobookshelf"
                            >
                              📚 Audiobookshelf
                            </Button>
                          )}
                          <div className="text-right text-xs text-soft">
                            <p>{formatBytes(document.size)}</p>
                            <p>{formatRelative(document.lastModified)}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          <section>
            <h4 className="mb-2 font-semibold text-foreground">Credit history</h4>
            {creditEvents.length === 0 ? (
              <EmptyBlock>No support credit activity.</EmptyBlock>
            ) : (
              <div className="overflow-hidden rounded-xl border border-line">
                <div className="divide-y divide-line">
                  {creditEvents.map((event) => (
                    <div key={event.id} className="bg-surface-sunken px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <p className={cn('text-sm font-semibold', event.amount > 0 ? 'text-accent' : 'text-foreground')}>
                          {event.amount > 0 ? '+' : ''}{event.amount} credit{Math.abs(event.amount) === 1 ? '' : 's'}
                        </p>
                        <p className="text-xs text-soft">{formatDate(event.createdAt)}</p>
                      </div>
                      <p className="mt-1 break-words text-xs text-soft">{event.detail}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      {audiobookshelfTarget && (
        <AudiobookshelfModal
          open={true}
          onClose={() => setAudiobookshelfTarget(null)}
          bookId={audiobookshelfTarget.bookId}
          userId={audiobookshelfTarget.userId}
          initialTitle={audiobookshelfTarget.title}
          documentType={audiobookshelfTarget.documentType}
        />
      )}
    </section>
  );
}

function JobCard({
  job,
  onChanged,
  onPushToAudiobookshelf,
}: {
  job: SupportJob;
  onChanged: () => void;
  onPushToAudiobookshelf?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const action = job.status === 'error'
    ? 'retry'
    : job.status === 'paused'
      ? 'resume'
      : ['queued', 'running', 'waiting_for_pdf', 'waiting_for_voices'].includes(job.status)
        ? 'pause'
        : null;

  const update = async () => {
    if (!action) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/support/jobs/${encodeURIComponent(job.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const result = await response.json() as { error?: string; job?: SupportJob };
      if (!response.ok) throw new Error(result.error || 'Unable to update job.');
      toast.success(action === 'pause' && result.job?.status === 'pausing'
        ? 'Pause requested. The worker will stop at its next safe checkpoint.'
        : `Job ${action === 'retry' ? 'queued for retry' : action === 'resume' ? 'resumed' : 'paused'}.`);
      onChanged();
    } catch (updateError) {
      toast.error(updateError instanceof Error ? updateError.message : 'Unable to update job.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-surface-sunken p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground">{job.documentTitle}</p>
            <StatusBadge status={job.status} />
          </div>
          <p className="mt-1 text-xs text-soft">
            {Math.round(job.progress)}% · Updated {formatRelative(job.updatedAt)}
            {job.voice ? ` · ${job.voice}` : ''}
            {job.model ? ` · ${job.model}` : ''}
          </p>
          {job.error ? <p className="mt-2 break-words text-xs text-danger">{job.error}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          {job.status === 'completed' && onPushToAudiobookshelf && (
            <Button size="sm" variant="secondary" onClick={onPushToAudiobookshelf}>
              📚 Push to Audiobookshelf
            </Button>
          )}
          {action ? (
            <Button size="sm" onClick={update} disabled={busy} variant={action === 'retry' ? 'primary' : 'secondary'}>
              {busy ? 'Working…' : humanizeAction(action)}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function JobsPanel() {
  const [status, setStatus] = useState('active');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [audiobookshelfJob, setAudiobookshelfJob] = useState<SupportJob | null>(null);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setQuery(searchInput.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);
  const key = `/api/admin/support/jobs?status=${encodeURIComponent(status)}&q=${encodeURIComponent(query)}&page=${page}&pageSize=50`;
  const { data, error, isLoading, mutate } = useSWR<SupportJobsResponse>(key, fetcher, {
    refreshInterval: status === 'active' ? 5_000 : 20_000,
    keepPreviousData: true,
  });
  return (
    <div className="space-y-5">
      <PanelHeading
        title="Audiobook jobs"
        description="Monitor the global queue, inspect failures, and safely pause, resume, or retry work."
        actions={<Button size="sm" onClick={() => mutate()}>Refresh</Button>}
      />
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
        <div className="flex flex-wrap gap-1">
          {['active', 'error', 'paused', 'completed', 'all'].map((filter) => (
            <Button
              key={filter}
              size="sm"
              variant={status === filter ? 'primary' : 'ghost'}
              onClick={() => { setStatus(filter); setPage(1); }}
            >
              {filter === 'error' ? 'Failed' : humanizeAction(filter)}
            </Button>
          ))}
        </div>
        <Input
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search user or book…"
          aria-label="Search audiobook jobs"
          className="ml-auto max-w-sm"
        />
      </div>
      {isLoading && !data ? <LoadingBlock label="Loading audiobook jobs…" /> : null}
      {error ? <ErrorBlock error={error} /> : null}
      {data?.jobs.length === 0 ? <EmptyBlock>No audiobook jobs match this view.</EmptyBlock> : null}
      <div className="space-y-2">
        {data?.jobs.map((job) => (
          <div key={job.id} className="rounded-xl border border-line bg-surface p-3 lg:p-4">
            <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold text-foreground">{job.documentTitle}</p>
                <p className="truncate text-xs text-soft">{job.userName} · {job.userEmail}</p>
              </div>
              <StatusBadge status={job.status} />
            </div>
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(job.progress)}%` }} />
            </div>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="text-xs text-soft">
                <p>{Math.round(job.progress)}% · Updated {formatRelative(job.updatedAt)}</p>
                <p>{job.voice || 'Default voice'}{job.model ? ` · ${job.model}` : ''}{job.monthlyQuotaCharge ? ' · Counts toward allowance' : ' · Included repair/retry'}</p>
                {job.error ? <p className="mt-2 max-w-4xl break-words text-danger">{job.error}</p> : null}
              </div>
              <div className="flex items-center gap-2">
                {job.status === 'completed' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setAudiobookshelfJob(job)}
                  >
                    📚 Push to Audiobookshelf
                  </Button>
                )}
                <JobCardActions job={job} onChanged={() => mutate()} />
              </div>
            </div>
          </div>
        ))}
      </div>
      {data && data.totalPages > 1 ? (
        <div className="flex items-center justify-center gap-3 text-xs text-soft">
          <Button size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button>
          <span>Page {data.page} of {data.totalPages} · {data.total} jobs</span>
          <Button size="sm" disabled={page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>Next</Button>
        </div>
      ) : null}
      {audiobookshelfJob && (
        <AudiobookshelfModal
          open={true}
          onClose={() => setAudiobookshelfJob(null)}
          bookId={audiobookshelfJob.documentId}
          userId={audiobookshelfJob.userId}
          initialTitle={audiobookshelfJob.documentTitle}
        />
      )}
    </div>
  );
}

function JobCardActions({ job, onChanged }: { job: SupportJob; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const action = job.status === 'error'
    ? 'retry'
    : job.status === 'paused'
      ? 'resume'
      : ['queued', 'running', 'waiting_for_pdf', 'waiting_for_voices'].includes(job.status)
        ? 'pause'
        : null;
  if (!action) return null;
  const run = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/support/jobs/${encodeURIComponent(job.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const result = await response.json() as { error?: string; job?: SupportJob };
      if (!response.ok) throw new Error(result.error || 'Unable to update job.');
      toast.success(action === 'pause' && result.job?.status === 'pausing'
        ? 'Pause requested. The worker will stop at its next safe checkpoint.'
        : `Job ${action === 'retry' ? 'queued for retry' : action === 'resume' ? 'resumed' : 'paused'}.`);
      onChanged();
    } catch (actionError) {
      toast.error(actionError instanceof Error ? actionError.message : 'Unable to update job.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant={action === 'retry' ? 'primary' : 'secondary'} onClick={run} disabled={busy}>
      {busy ? 'Working…' : humanizeAction(action)}
    </Button>
  );
}

function PaymentsPanel() {
  const [status, setStatus] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setQuery(searchInput.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  const key = `/api/admin/support/payments?status=${encodeURIComponent(status)}&q=${encodeURIComponent(query)}&page=${page}&pageSize=50`;
  const { data, error, isLoading, mutate } = useSWR<SupportPaymentsResponse>(key, fetcher, {
    refreshInterval: 20_000,
    keepPreviousData: true,
  });
  const attentionCount = data?.payments.filter((payment) => (
    payment.status === 'review_required' || payment.reversalShortfall > 0
  )).length || 0;

  return (
    <div className="space-y-5">
      <PanelHeading
        title="PayPal payments"
        description="Track support-credit checkout, grants, refunds, and items that need manual review."
        actions={<Button size="sm" onClick={() => mutate()}>Refresh</Button>}
      />

      {data ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Checkout"
            value={data.paypal.enabled ? 'Ready' : 'Not ready'}
            detail={`${data.paypal.environment === 'live' ? 'Live' : 'Sandbox'} PayPal environment`}
          />
          <StatCard label="Visible payments" value={data.payments.length} detail={`${data.total} matching all pages`} />
          <StatCard label="Needs attention" value={attentionCount} detail="On this page" />
          <StatCard
            label="Webhook"
            value={data.paypal.webhookConfigured ? 'Configured' : 'Missing'}
            detail={data.paypal.siteOriginConfigured ? 'Site URL configured' : 'BASE_URL is missing'}
          />
        </div>
      ) : null}

      {data && !data.paypal.enabled ? (
        <div className="rounded-xl border border-danger bg-danger-wash p-4 text-sm text-danger">
          Automatic checkout is disabled. Check the PayPal credentials, webhook ID, BASE_URL, and HTTPS requirement for live mode.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
        <label className="text-xs font-semibold text-soft" htmlFor="payment-status">Status</label>
        <select
          id="payment-status"
          value={status}
          onChange={(event) => { setStatus(event.target.value); setPage(1); }}
          className="h-9 rounded-md border border-line bg-surface-sunken px-2 text-sm text-foreground"
        >
          {['all', 'completed', 'awaiting_approval', 'capture_pending', 'review_required', 'refunded', 'reversed', 'failed']
            .map((value) => <option key={value} value={value}>{humanizeAction(value)}</option>)}
        </select>
        <Input
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search email or payment ID…"
          aria-label="Search PayPal payments"
          className="ml-auto max-w-sm"
        />
      </div>

      {isLoading && !data ? <LoadingBlock label="Loading PayPal payments…" /> : null}
      {error ? <ErrorBlock error={error} /> : null}
      {data?.payments.length === 0 ? <EmptyBlock>No PayPal payments match this view.</EmptyBlock> : null}
      {data?.payments.length ? (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[980px] text-left text-xs">
            <thead className="bg-surface-sunken text-soft">
              <tr>
                <th className="px-3 py-2 font-semibold">Created</th>
                <th className="px-3 py-2 font-semibold">User</th>
                <th className="px-3 py-2 font-semibold">Package</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Credits</th>
                <th className="px-3 py-2 font-semibold">PayPal references</th>
                <th className="px-3 py-2 font-semibold">Attention</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.payments.map((payment) => (
                <tr key={payment.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-3 text-soft">
                    <p>{formatDate(payment.createdAt)}</p>
                    <p className="mt-1 uppercase">{payment.environment}</p>
                  </td>
                  <td className="max-w-56 px-3 py-3">
                    <p className="truncate font-medium text-foreground">{payment.userEmail || 'Deleted account'}</p>
                    <p className="mt-1 truncate font-mono text-[10px] text-soft" title={payment.userId}>{payment.userId}</p>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-foreground">
                    <p className="font-semibold">{formatMoney(payment.amountCents, payment.currency)}</p>
                    <p className="mt-1 text-soft">{payment.credits} audiobook credits</p>
                  </td>
                  <td className="px-3 py-3"><StatusBadge status={payment.status} /></td>
                  <td className="whitespace-nowrap px-3 py-3 text-soft">
                    <p>{payment.creditsGranted} granted</p>
                    <p>{payment.creditsRevoked} revoked</p>
                  </td>
                  <td className="max-w-64 px-3 py-3 font-mono text-[10px] text-soft">
                    <p className="truncate" title={payment.paypalOrderId || undefined}>Order: {payment.paypalOrderId || '—'}</p>
                    <p className="mt-1 truncate" title={payment.paypalCaptureId || undefined}>Capture: {payment.paypalCaptureId || '—'}</p>
                    <p className="mt-1 truncate" title={payment.id}>Local: {payment.id}</p>
                  </td>
                  <td className="max-w-64 px-3 py-3 text-soft">
                    {payment.failureCode ? <p className="font-medium text-danger">{humanizeAction(payment.failureCode)}</p> : <p>None</p>}
                    {payment.reversalShortfall > 0 ? (
                      <p className="mt-1 text-danger">{payment.reversalShortfall} already-used credits need review.</p>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {data && data.totalPages > 1 ? (
        <div className="flex items-center justify-center gap-3 text-xs text-soft">
          <Button size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button>
          <span>Page {data.page} of {data.totalPages} · {data.total} payments</span>
          <Button size="sm" disabled={page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>Next</Button>
        </div>
      ) : null}
    </div>
  );
}

function JoinRequestsPanel() {
  const { data, error, isLoading, mutate } = useSWR<{ requests: SupportJoinRequest[] }>(
    '/api/admin/support/join-requests',
    fetcher,
    { refreshInterval: 30_000 },
  );
  const [filter, setFilter] = useState('pending');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const requests = useMemo(() => (
    (data?.requests || []).filter((request) => filter === 'all' || request.status === filter)
  ), [data, filter]);

  const decide = async (request: SupportJoinRequest, decision: 'approve' | 'deny') => {
    if (!window.confirm(`${decision === 'approve' ? 'Approve' : 'Deny'} access for ${request.email}?`)) return;
    setBusyId(request.id);
    try {
      const response = await fetch('/api/admin/support/join-requests', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: request.id, decision, note: notes[request.id] || '' }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || 'Unable to update request.');
      toast.success(`Request ${decision === 'approve' ? 'approved' : 'denied'}.`);
      await mutate();
    } catch (decisionError) {
      toast.error(decisionError instanceof Error ? decisionError.message : 'Unable to update request.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      <PanelHeading
        title="Join requests"
        description="Review how applicants plan to use OpenReader and approve access without leaving the console."
        actions={<Button size="sm" onClick={() => mutate()}>Refresh</Button>}
      />
      <div className="flex gap-1">
        {['pending', 'approved', 'denied', 'all'].map((status) => (
          <Button key={status} size="sm" variant={filter === status ? 'primary' : 'ghost'} onClick={() => setFilter(status)}>
            {humanizeAction(status)}
          </Button>
        ))}
      </div>
      {isLoading ? <LoadingBlock label="Loading join requests…" /> : null}
      {error ? <ErrorBlock error={error} /> : null}
      {!isLoading && requests.length === 0 ? <EmptyBlock>No join requests in this view.</EmptyBlock> : null}
      <div className="grid gap-3 xl:grid-cols-2">
        {requests.map((request) => (
          <article key={request.id} className="rounded-xl border border-line bg-surface p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate font-semibold text-foreground">{request.name || request.email}</h3>
                <p className="truncate text-sm text-soft">{request.email}</p>
                <p className="mt-1 text-xs text-soft">Requested {formatDate(request.createdAt)}</p>
              </div>
              <StatusBadge status={request.status} />
            </div>
            <div className="mt-4 space-y-3 text-sm">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-soft">Planned use</p>
                <p className="mt-1 whitespace-pre-wrap text-foreground">{request.intendedUse}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-soft">How they heard about it</p>
                <p className="mt-1 whitespace-pre-wrap text-foreground">{request.heardAbout}</p>
              </div>
            </div>
            {request.status === 'pending' ? (
              <div className="mt-4 space-y-2 border-t border-line pt-3">
                <Input
                  value={notes[request.id] || ''}
                  onChange={(event) => setNotes((current) => ({ ...current, [request.id]: event.target.value }))}
                  placeholder="Optional decision note"
                  aria-label={`Decision note for ${request.email}`}
                />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" disabled={busyId === request.id} onClick={() => decide(request, 'deny')}>Deny</Button>
                  <Button size="sm" variant="primary" disabled={busyId === request.id} onClick={() => decide(request, 'approve')}>Approve</Button>
                </div>
              </div>
            ) : request.decisionNote ? (
              <p className="mt-4 border-t border-line pt-3 text-xs text-soft">Decision note: {request.decisionNote}</p>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}

type SystemResponse = {
  tasks: Array<{
    key: string;
    name: string;
    enabled: boolean;
    running: boolean;
    lastStatus: string;
    lastRunAt: number | null;
    nextRunAt: number | null;
    lastError: string | null;
  }>;
  logs: Array<{
    id: string;
    userId: string | null;
    severity: string;
    context: string;
    message: string;
    details: string | null;
    createdAt: number;
  }>;
  scheduler: { mode: string };
};

function SystemPanel() {
  const { data, error, isLoading, mutate } = useSWR<SystemResponse>(
    '/api/admin/support/system',
    fetcher,
    { refreshInterval: 10_000 },
  );
  return (
    <div className="space-y-5">
      <PanelHeading
        title="System"
        description="Background maintenance and recent application diagnostics."
        actions={<Button size="sm" onClick={() => mutate()}>Refresh</Button>}
      />
      {isLoading ? <LoadingBlock label="Loading system status…" /> : null}
      {error ? <ErrorBlock error={error} /> : null}
      {data ? (
        <>
          <section className="rounded-xl border border-line bg-surface p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="font-semibold text-foreground">Scheduled tasks</h3>
              <span className="text-xs text-soft">Scheduler: {data.scheduler.mode}</span>
            </div>
            <div className="grid gap-2 lg:grid-cols-2 2xl:grid-cols-3">
              {data.tasks.map((task) => (
                <div key={task.key} className="rounded-lg border border-line bg-surface-sunken p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-foreground">{task.name}</p>
                    <StatusBadge status={task.running ? 'running' : task.lastStatus} />
                  </div>
                  <p className="mt-2 text-xs text-soft">Last run: {formatRelative(task.lastRunAt)}</p>
                  <p className="text-xs text-soft">Next run: {task.nextRunAt ? formatDate(task.nextRunAt) : 'Not scheduled'}</p>
                  {task.lastError ? <p className="mt-2 line-clamp-2 text-xs text-danger">{task.lastError}</p> : null}
                </div>
              ))}
            </div>
          </section>
          <section className="rounded-xl border border-line bg-surface p-4">
            <h3 className="mb-3 font-semibold text-foreground">Recent diagnostic logs</h3>
            {data.logs.length === 0 ? <EmptyBlock>No diagnostic logs recorded.</EmptyBlock> : (
              <div className="max-h-[560px] overflow-auto rounded-lg border border-line">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead className="sticky top-0 bg-surface-sunken text-soft">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Time</th>
                      <th className="px-3 py-2 font-semibold">Severity</th>
                      <th className="px-3 py-2 font-semibold">Context</th>
                      <th className="px-3 py-2 font-semibold">Message</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.logs.map((log) => (
                      <tr key={log.id} className="align-top">
                        <td className="whitespace-nowrap px-3 py-2 text-soft">{formatDate(log.createdAt)}</td>
                        <td className="px-3 py-2"><StatusBadge status={log.severity} /></td>
                        <td className="px-3 py-2 text-soft">{log.context}</td>
                        <td className="max-w-3xl px-3 py-2 text-foreground">
                          <p>{log.message}</p>
                          {log.details ? <p className="mt-1 break-words font-mono text-[10px] text-soft">{log.details}</p> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

function AuditPanel() {
  const [page, setPage] = useState(1);
  const { data, error, isLoading, mutate } = useSWR<SupportAuditResponse>(
    `/api/admin/support/audit?page=${page}&pageSize=50`,
    fetcher,
  );
  return (
    <div className="space-y-5">
      <PanelHeading
        title="Audit log"
        description="A permanent support history for credit grants, job interventions, and access decisions."
        actions={<Button size="sm" onClick={() => mutate()}>Refresh</Button>}
      />
      {isLoading ? <LoadingBlock label="Loading audit history…" /> : null}
      {error ? <ErrorBlock error={error} /> : null}
      {data?.events.length === 0 ? <EmptyBlock>No administrator support actions recorded yet.</EmptyBlock> : null}
      {data?.events.length ? (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className="overflow-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="bg-surface-sunken text-xs text-soft">
              <tr>
                <th className="px-4 py-3 font-semibold">Time</th>
                <th className="px-4 py-3 font-semibold">Action</th>
                <th className="px-4 py-3 font-semibold">Target</th>
                <th className="px-4 py-3 font-semibold">Amount</th>
                <th className="px-4 py-3 font-semibold">Note</th>
                <th className="px-4 py-3 font-semibold">Administrator</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.events.map((event) => (
                <tr key={event.id} className="align-top">
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-soft">{formatDate(event.createdAt)}</td>
                  <td className="px-4 py-3 font-medium text-foreground">{humanizeAction(event.action)}</td>
                  <td className="max-w-48 truncate px-4 py-3 text-xs text-soft" title={event.targetEmail || event.targetUserId || event.resourceId || ''}>
                    {event.targetEmail || event.targetUserId || event.resourceId || '—'}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-foreground">{event.amount === null ? '—' : `${event.amount > 0 ? '+' : ''}${event.amount}`}</td>
                  <td className="max-w-md px-4 py-3 text-soft">{event.note || '—'}</td>
                  <td className="max-w-48 truncate px-4 py-3 text-xs text-soft" title={event.adminEmail || event.adminUserId}>{event.adminEmail || event.adminUserId}</td>
                </tr>
              ))}
            </tbody>
            </table>
          </div>
          {data.totalPages > 1 ? (
            <div className="flex items-center justify-between border-t border-line p-3 text-xs text-soft">
              <Button size="xs" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button>
              <span>Page {data.page} of {data.totalPages} · {data.total} actions</span>
              <Button size="xs" disabled={page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>Next</Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
