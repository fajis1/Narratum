import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  max,
  notLike,
  or,
  sql,
  sum,
} from 'drizzle-orm';
import { db } from '@/db';
import {
  audiobooks,
  audiobookJobs,
  documents,
  supportAuditEvents,
  supportPayments,
  systemLogs,
  userDocumentProgress,
} from '@/db/schema';
import * as authSchemaSqlite from '@/db/schema_auth_sqlite';
import * as authSchemaPostgres from '@/db/schema_auth_postgres';
import {
  calculateMonthlyAudiobookAllowance,
  checkMonthlyAudiobookQuota,
  getAudiobookCreditLedger,
  getAudiobookCreditLedgers,
  getMonthlyAudiobookUsageCounts,
  grantAudiobookCredits,
} from '@/lib/server/access/audiobook-quota';
import { listJoinRequests } from '@/lib/server/access/join-requests';
import { getRuntimeConfig } from '@/lib/server/admin/settings';
import { getPayPalReadiness } from '@/lib/server/paypal/config';
import { runTaskNow } from '@/lib/server/tasks/engine';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import {
  SUPPORT_ACTIVE_JOB_STATUSES,
  type SupportAuditEvent,
  type SupportAuditResponse,
  type SupportJob,
  type SupportJobsResponse,
  type SupportOverview,
  type SupportPayment,
  type SupportPaymentsResponse,
  type SupportQuota,
  type SupportUserDetail,
  type SupportUsersResponse,
  type SupportUserSummary,
} from '@/lib/shared/admin-support';

const authUser = process.env.POSTGRES_URL ? authSchemaPostgres.user : authSchemaSqlite.user;
const authSession = process.env.POSTGRES_URL ? authSchemaPostgres.session : authSchemaSqlite.session;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

type AuthUserRow = {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  createdAt: Date | number | string;
  updatedAt: Date | number | string;
};

function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseStoredValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function boundedText(value: unknown, maxLength: number): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

export function redactSupportDiagnosticText(value: unknown): string | null {
  const text = boundedText(value, 2_000);
  if (!text) return null;
  return redactSensitiveSupportText(text);
}

function redactSensitiveSupportText(text: string): string {
  return text
    .replace(/("authorization"\s*:\s*"bearer\s+)[^"]+/gi, '$1[redacted]')
    .replace(/("(?:api[_-]?key|apikey|secret|token)"\s*:\s*")[^"]+/gi, '$1[redacted]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/([?&](?:token|key|api_key|apiKey)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|apikey|secret|token)\s*[:=]\s*)[^\s,;&]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|gho|github_pat)_[A-Za-z0-9_-]{12,}\b/g, '[redacted]');
}

function redactSupportLogDetails(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().slice(0, 100_000);
  return text ? redactSensitiveSupportText(text) : null;
}

function normalizePage(value: number | undefined): number {
  return Math.max(1, Math.floor(Number(value) || 1));
}

function normalizePageSize(value: number | undefined): number {
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(value) || DEFAULT_PAGE_SIZE)));
}

function nonAnonymousUserCondition() {
  return and(
    or(eq(authUser.isAnonymous, false), isNull(authUser.isAnonymous)),
    notLike(authUser.email, '%@local'),
  );
}

function startOfUtcMonthMs(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function nextUtcMonthMs(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

function parseJobSettings(value: unknown): Record<string, unknown> {
  const parsed = parseStoredValue(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function toSupportJob(row: {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  documentId: string;
  documentTitle: string | null;
  status: string;
  progress: number | null;
  error: string | null;
  settingsJson: unknown;
  createdAt: number | null;
  updatedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
}): SupportJob {
  const settings = parseJobSettings(row.settingsJson);
  return {
    id: row.id,
    userId: row.userId,
    userName: row.userName || 'Unknown user',
    userEmail: row.userEmail || 'Unknown email',
    documentId: row.documentId,
    documentTitle: row.documentTitle || 'Untitled document',
    status: row.status,
    progress: Math.max(0, Math.min(100, Number(row.progress ?? 0))),
    error: redactSupportDiagnosticText(row.error),
    createdAt: toMs(row.createdAt),
    updatedAt: toMs(row.updatedAt),
    startedAt: row.startedAt === null ? null : toMs(row.startedAt),
    completedAt: row.completedAt === null ? null : toMs(row.completedAt),
    voice: typeof settings.voice === 'string' ? boundedText(settings.voice, 100) : null,
    model: typeof settings.ttsModel === 'string' ? boundedText(settings.ttsModel, 160) : null,
    format: typeof settings.format === 'string' ? boundedText(settings.format, 20) : null,
    smartAudio: settings.useSmartAudio === true,
    monthlyQuotaCharge: settings.monthlyQuotaCharge !== false && settings.batchRegenerate !== true,
  };
}

async function hydrateSupportUsers(userRows: AuthUserRow[]): Promise<SupportUserSummary[]> {
  const userIds = userRows.map((user) => user.id);
  if (userIds.length === 0) return [];
  const monthStart = startOfUtcMonthMs();

  const [
    documentRows,
    audiobookRows,
    jobRows,
    progressRows,
    sessionRows,
    usageByUser,
    ledgers,
    runtime,
  ] = await Promise.all([
    db.select({
      userId: documents.userId,
      documentCount: count(),
      storageBytes: sum(documents.size),
      lastActiveAt: max(documents.lastModified),
    }).from(documents).where(inArray(documents.userId, userIds)).groupBy(documents.userId),
    db.select({
      userId: audiobooks.userId,
      audiobookCount: count(),
      storageBytes: sum(audiobooks.totalBytes),
      lastActiveAt: max(audiobooks.createdAt),
    }).from(audiobooks).where(inArray(audiobooks.userId, userIds)).groupBy(audiobooks.userId),
    db.select({
      userId: audiobookJobs.userId,
      status: audiobookJobs.status,
      jobCount: count(),
      lastActiveAt: max(audiobookJobs.updatedAt),
    }).from(audiobookJobs).where(inArray(audiobookJobs.userId, userIds))
      .groupBy(audiobookJobs.userId, audiobookJobs.status),
    db.select({
      userId: userDocumentProgress.userId,
      lastActiveAt: max(userDocumentProgress.updatedAt),
    }).from(userDocumentProgress).where(inArray(userDocumentProgress.userId, userIds))
      .groupBy(userDocumentProgress.userId),
    db.select({
      userId: authSession.userId,
      lastActiveAt: max(authSession.updatedAt),
    }).from(authSession).where(inArray(authSession.userId, userIds)).groupBy(authSession.userId),
    getMonthlyAudiobookUsageCounts(userIds, monthStart),
    getAudiobookCreditLedgers(userIds),
    getRuntimeConfig(),
  ]);

  const docsByUser = new Map((documentRows as Array<Record<string, unknown>>)
    .map((row) => [String(row.userId), row]));
  const audiobooksByUser = new Map((audiobookRows as Array<Record<string, unknown>>)
    .map((row) => [String(row.userId), row]));
  const progressByUser = new Map((progressRows as Array<Record<string, unknown>>)
    .map((row) => [String(row.userId), row]));
  const sessionsByUser = new Map((sessionRows as Array<Record<string, unknown>>)
    .map((row) => [String(row.userId), row]));
  const jobsByUser = new Map<string, Array<Record<string, unknown>>>();
  for (const row of jobRows as Array<Record<string, unknown>>) {
    const userId = String(row.userId);
    jobsByUser.set(userId, [...(jobsByUser.get(userId) || []), row]);
  }

  const resetTimeMs = nextUtcMonthMs();
  return userRows.map((user) => {
    const doc = docsByUser.get(user.id);
    const audiobook = audiobooksByUser.get(user.id);
    const progress = progressByUser.get(user.id);
    const session = sessionsByUser.get(user.id);
    const jobs = jobsByUser.get(user.id) || [];
    const ledger = ledgers.get(user.id);
    const allowance = calculateMonthlyAudiobookAllowance({
      used: usageByUser.get(user.id) || 0,
      freeLimit: runtime.monthlyAudiobookLimit,
      paidCreditsAvailable: ledger?.available || 0,
    });
    const quota: SupportQuota = user.isAdmin
      ? {
          unlimited: true,
          used: 0,
          freeLimit: runtime.monthlyAudiobookLimit,
          freeUsed: 0,
          freeRemaining: runtime.monthlyAudiobookLimit,
          supportCreditsRemaining: ledger?.available || 0,
          totalRemaining: runtime.monthlyAudiobookLimit + (ledger?.available || 0),
          resetTimeMs,
        }
      : { unlimited: false, ...allowance, resetTimeMs };
    const jobActivity = Math.max(0, ...jobs.map((row) => toMs(row.lastActiveAt)));
    const lastActiveAt = Math.max(
      toMs(user.updatedAt),
      toMs(user.createdAt),
      toMs(doc?.lastActiveAt),
      toMs(audiobook?.lastActiveAt),
      toMs(progress?.lastActiveAt),
      toMs(session?.lastActiveAt),
      jobActivity,
    );
    return {
      id: user.id,
      name: user.name || 'Unnamed user',
      email: user.email,
      isAdmin: Boolean(user.isAdmin),
      createdAt: toMs(user.createdAt),
      lastActiveAt,
      documentCount: toNumber(doc?.documentCount),
      audiobookCount: toNumber(audiobook?.audiobookCount),
      storageBytes: toNumber(doc?.storageBytes) + toNumber(audiobook?.storageBytes),
      activeJobCount: jobs
        .filter((row) => SUPPORT_ACTIVE_JOB_STATUSES.includes(String(row.status) as never))
        .reduce((total, row) => total + toNumber(row.jobCount), 0),
      failedJobCount: jobs
        .filter((row) => row.status === 'error')
        .reduce((total, row) => total + toNumber(row.jobCount), 0),
      quota,
    };
  });
}

export async function listSupportUsers(input: {
  query?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<SupportUsersResponse> {
  const page = normalizePage(input.page);
  const pageSize = normalizePageSize(input.pageSize);
  const query = boundedText(input.query, 120).toLowerCase();
  const conditions = [nonAnonymousUserCondition()];
  if (query) {
    const pattern = `%${query}%`;
    conditions.push(sql`(lower(${authUser.name}) like ${pattern} or lower(${authUser.email}) like ${pattern})`);
  }
  const where = and(...conditions);
  const [rows, totalRows] = await Promise.all([
    db.select({
      id: authUser.id,
      name: authUser.name,
      email: authUser.email,
      isAdmin: authUser.isAdmin,
      createdAt: authUser.createdAt,
      updatedAt: authUser.updatedAt,
    }).from(authUser).where(where)
      .orderBy(desc(authUser.createdAt), asc(authUser.email))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(authUser).where(where),
  ]);
  const users = await hydrateSupportUsers(rows as AuthUserRow[]);
  const total = toNumber(totalRows[0]?.value);
  return {
    users,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

async function querySupportJobs(input: {
  status?: string;
  query?: string;
  targetUserId?: string;
  jobId?: string;
  page?: number;
  pageSize?: number;
}): Promise<SupportJobsResponse> {
  const page = normalizePage(input.page);
  const pageSize = normalizePageSize(input.pageSize);
  const conditions = [];
  if (input.targetUserId) conditions.push(eq(audiobookJobs.userId, input.targetUserId));
  if (input.jobId) conditions.push(eq(audiobookJobs.id, input.jobId));
  if (input.status === 'active') {
    conditions.push(inArray(audiobookJobs.status, [...SUPPORT_ACTIVE_JOB_STATUSES]));
  } else if (input.status && input.status !== 'all') {
    conditions.push(eq(audiobookJobs.status, input.status));
  }
  const query = boundedText(input.query, 120).toLowerCase();
  if (query) {
    const pattern = `%${query}%`;
    conditions.push(sql`(lower(${authUser.email}) like ${pattern} or lower(${authUser.name}) like ${pattern} or lower(${documents.name}) like ${pattern})`);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const joinDocument = and(
    eq(documents.id, audiobookJobs.documentId),
    eq(documents.userId, audiobookJobs.userId),
  );
  const baseSelect = {
    id: audiobookJobs.id,
    userId: audiobookJobs.userId,
    userName: authUser.name,
    userEmail: authUser.email,
    documentId: audiobookJobs.documentId,
    documentTitle: documents.name,
    status: audiobookJobs.status,
    progress: audiobookJobs.progress,
    error: audiobookJobs.error,
    settingsJson: audiobookJobs.settingsJson,
    createdAt: audiobookJobs.createdAt,
    updatedAt: audiobookJobs.updatedAt,
    startedAt: audiobookJobs.startedAt,
    completedAt: audiobookJobs.completedAt,
  };
  const [rows, totalRows] = await Promise.all([
    db.select(baseSelect).from(audiobookJobs)
      .leftJoin(documents, joinDocument)
      .leftJoin(authUser, eq(authUser.id, audiobookJobs.userId))
      .where(where)
      .orderBy(desc(audiobookJobs.updatedAt), desc(audiobookJobs.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(audiobookJobs)
      .leftJoin(documents, joinDocument)
      .leftJoin(authUser, eq(authUser.id, audiobookJobs.userId))
      .where(where),
  ]);
  const total = toNumber(totalRows[0]?.value);
  return {
    jobs: (rows as Parameters<typeof toSupportJob>[0][]).map(toSupportJob),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function listSupportJobs(input: {
  status?: string;
  query?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<SupportJobsResponse> {
  return querySupportJobs(input);
}

export async function getSupportUserDetail(userId: string): Promise<SupportUserDetail | null> {
  const rows = await db.select({
    id: authUser.id,
    name: authUser.name,
    email: authUser.email,
    isAdmin: authUser.isAdmin,
    createdAt: authUser.createdAt,
    updatedAt: authUser.updatedAt,
  }).from(authUser).where(and(
    eq(authUser.id, userId),
    nonAnonymousUserCondition(),
  )).limit(1);
  if (rows.length === 0) return null;

  // The detail view uses the canonical quota calculation, including lazy
  // backfill of current-month jobs created before the durable ledger existed.
  const authRow = rows[0] as AuthUserRow;
  const [summaries, quota, recentDocuments, recentJobs, ledger] = await Promise.all([
    hydrateSupportUsers([authRow]),
    checkMonthlyAudiobookQuota({ userId, isAdmin: Boolean(authRow.isAdmin) }),
    db.select({
      id: documents.id,
      name: documents.name,
      type: documents.type,
      size: documents.size,
      lastModified: documents.lastModified,
    }).from(documents).where(eq(documents.userId, userId))
      .orderBy(desc(documents.lastModified)).limit(25),
    querySupportJobs({ targetUserId: userId, pageSize: 25 }),
    getAudiobookCreditLedger(userId),
  ]);
  const user = {
    ...summaries[0],
    quota: {
      unlimited: quota.unlimited,
      used: quota.used,
      freeLimit: quota.freeLimit,
      freeUsed: quota.freeUsed,
      freeRemaining: quota.freeRemaining,
      supportCreditsRemaining: quota.supportCreditsRemaining,
      totalRemaining: quota.totalRemaining,
      resetTimeMs: quota.resetTimeMs,
    },
  };
  return {
    user,
    supportPackage: {
      minimumUsd: quota.supportMinimumUsd,
      extraAudiobooks: quota.supportExtraAudiobooks,
    },
    recentDocuments: (recentDocuments as Array<Record<string, unknown>>).map((document) => ({
      id: String(document.id),
      name: String(document.name),
      type: String(document.type),
      size: toNumber(document.size),
      lastModified: toMs(document.lastModified),
    })),
    recentJobs: recentJobs.jobs,
    creditHistory: {
      grantedTotal: ledger.grantedTotal,
      consumedTotal: ledger.consumedTotal,
      revokedTotal: ledger.revokedTotal,
      available: ledger.available,
      outstandingDebt: ledger.outstandingDebt,
      grants: [...ledger.grants].sort((left, right) => right.createdAt - left.createdAt),
      consumptions: [...ledger.consumptions].sort((left, right) => right.createdAt - left.createdAt),
      revocations: [...ledger.revocations].sort((left, right) => right.createdAt - left.createdAt),
    },
  };
}

export async function listSupportPayments(input: {
  status?: string;
  query?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<SupportPaymentsResponse> {
  const page = normalizePage(input.page);
  const pageSize = normalizePageSize(input.pageSize);
  const conditions = [];
  const status = boundedText(input.status, 40).toLowerCase();
  if (status && status !== 'all') conditions.push(eq(supportPayments.status, status));
  const query = boundedText(input.query, 120).toLowerCase();
  if (query) {
    const pattern = `%${query}%`;
    conditions.push(sql`(
      lower(coalesce(${authUser.email}, '')) like ${pattern}
      or lower(${supportPayments.id}) like ${pattern}
      or lower(coalesce(${supportPayments.paypalOrderId}, '')) like ${pattern}
      or lower(coalesce(${supportPayments.paypalCaptureId}, '')) like ${pattern}
    )`);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const select = {
    id: supportPayments.id,
    userId: supportPayments.userId,
    userEmail: authUser.email,
    environment: supportPayments.environment,
    paypalOrderId: supportPayments.paypalOrderId,
    paypalCaptureId: supportPayments.paypalCaptureId,
    status: supportPayments.status,
    amountCents: supportPayments.amountCents,
    currency: supportPayments.currency,
    credits: supportPayments.credits,
    creditsGranted: supportPayments.creditsGranted,
    creditsRevoked: supportPayments.creditsRevoked,
    reversalShortfall: supportPayments.reversalShortfall,
    failureCode: supportPayments.failureCode,
    createdAt: supportPayments.createdAt,
    updatedAt: supportPayments.updatedAt,
    completedAt: supportPayments.completedAt,
    reversedAt: supportPayments.reversedAt,
  };
  const [rows, totalRows] = await Promise.all([
    db.select(select).from(supportPayments)
      .leftJoin(authUser, eq(authUser.id, supportPayments.userId))
      .where(where)
      .orderBy(desc(supportPayments.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(supportPayments)
      .leftJoin(authUser, eq(authUser.id, supportPayments.userId))
      .where(where),
  ]);
  const payments: SupportPayment[] = (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    userId: String(row.userId),
    userEmail: typeof row.userEmail === 'string' ? row.userEmail : null,
    environment: String(row.environment),
    paypalOrderId: typeof row.paypalOrderId === 'string' ? row.paypalOrderId : null,
    paypalCaptureId: typeof row.paypalCaptureId === 'string' ? row.paypalCaptureId : null,
    status: String(row.status),
    amountCents: toNumber(row.amountCents),
    currency: String(row.currency),
    credits: toNumber(row.credits),
    creditsGranted: toNumber(row.creditsGranted),
    creditsRevoked: toNumber(row.creditsRevoked),
    reversalShortfall: toNumber(row.reversalShortfall),
    failureCode: typeof row.failureCode === 'string' ? row.failureCode : null,
    createdAt: toMs(row.createdAt),
    updatedAt: toMs(row.updatedAt),
    completedAt: row.completedAt === null ? null : toMs(row.completedAt),
    reversedAt: row.reversedAt === null ? null : toMs(row.reversedAt),
  }));
  const total = toNumber(totalRows[0]?.value);
  return {
    payments,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    paypal: getPayPalReadiness(),
  };
}

type SupportAuditInput = {
  adminUserId: string;
  targetUserId?: string | null;
  action: string;
  resourceId?: string | null;
  amount?: number | null;
  note?: string | null;
  id?: string;
};

function prepareSupportAudit(input: SupportAuditInput): SupportAuditEvent {
  const requestedId = boundedText(input.id, 180);
  return {
    id: requestedId || randomUUID(),
    adminUserId: input.adminUserId,
    adminEmail: null,
    targetUserId: input.targetUserId || null,
    targetEmail: null,
    action: boundedText(input.action, 80),
    resourceId: boundedText(input.resourceId, 180) || null,
    amount: typeof input.amount === 'number' && Number.isFinite(input.amount) ? input.amount : null,
    note: boundedText(input.note, 500) || null,
    createdAt: Date.now(),
  };
}

function supportAuditInsert(database: typeof db, event: SupportAuditEvent) {
  return database.insert(supportAuditEvents).values({
    id: event.id,
    adminUserId: event.adminUserId,
    targetUserId: event.targetUserId,
    action: event.action,
    resourceId: event.resourceId,
    amount: event.amount,
    note: event.note,
    createdAt: event.createdAt,
  }).onConflictDoNothing({ target: supportAuditEvents.id });
}

export async function recordSupportAudit(
  input: SupportAuditInput,
  database: typeof db = db,
): Promise<SupportAuditEvent> {
  const event = prepareSupportAudit(input);
  await supportAuditInsert(database, event);
  return event;
}

function recordSupportAuditSync(input: SupportAuditInput, database: typeof db): SupportAuditEvent {
  const event = prepareSupportAudit(input);
  supportAuditInsert(database, event).run();
  return event;
}

export async function listSupportAudit(input: {
  page?: number;
  pageSize?: number;
} = {}): Promise<SupportAuditResponse> {
  const page = normalizePage(input.page);
  const pageSize = normalizePageSize(input.pageSize);
  const [rows, totalRows] = await Promise.all([
    db.select({
      id: supportAuditEvents.id,
      adminUserId: supportAuditEvents.adminUserId,
      targetUserId: supportAuditEvents.targetUserId,
      action: supportAuditEvents.action,
      resourceId: supportAuditEvents.resourceId,
      amount: supportAuditEvents.amount,
      note: supportAuditEvents.note,
      createdAt: supportAuditEvents.createdAt,
    }).from(supportAuditEvents)
      .orderBy(desc(supportAuditEvents.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(supportAuditEvents),
  ]);
  const events: SupportAuditEvent[] = (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    adminUserId: String(row.adminUserId),
    adminEmail: null,
    targetUserId: typeof row.targetUserId === 'string' ? row.targetUserId : null,
    targetEmail: null,
    action: boundedText(row.action, 80),
    resourceId: typeof row.resourceId === 'string' ? boundedText(row.resourceId, 180) : null,
    amount: row.amount === null ? null : toNumber(row.amount),
    note: typeof row.note === 'string' ? boundedText(row.note, 500) || null : null,
    createdAt: toMs(row.createdAt),
  }));
  const userIds = Array.from(new Set(events.flatMap((event) => (
    [event.adminUserId, event.targetUserId].filter((value): value is string => Boolean(value))
  ))));
  let hydratedEvents = events;
  if (userIds.length > 0) {
    const users = await db.select({ id: authUser.id, email: authUser.email })
      .from(authUser)
      .where(inArray(authUser.id, userIds));
    const emails = new Map((users as Array<{ id: string; email: string }>).map((user) => [user.id, user.email]));
    hydratedEvents = events.map((event) => ({
      ...event,
      adminEmail: emails.get(event.adminUserId) || null,
      targetEmail: event.targetUserId ? emails.get(event.targetUserId) || null : null,
    }));
  }
  const total = toNumber(totalRows[0]?.value);
  return {
    events: hydratedEvents,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function grantSupportCredits(input: {
  adminUserId: string;
  targetUserId: string;
  credits: number;
  note?: string | null;
  idempotencyKey?: string;
}) {
  const id = boundedText(input.idempotencyKey, 180) || randomUUID();
  const note = boundedText(input.note, 500) || null;
  if (!note) throw new Error('A reason or payment reference is required.');
  const targetRows = await db.select({ id: authUser.id })
    .from(authUser)
    .where(and(eq(authUser.id, input.targetUserId), nonAnonymousUserCondition()))
    .limit(1);
  if (targetRows.length === 0) throw new Error('User not found.');
  const ledger = await grantAudiobookCredits({
    userId: input.targetUserId,
    credits: input.credits,
    note,
    createdByAdminId: input.adminUserId,
    id,
  });
  const grant = ledger.grants.find((entry) => entry.id === id);
  const auditNote = grant?.debtOffset
    ? boundedText(`${note} · ${grant.debtOffset} credit${grant.debtOffset === 1 ? '' : 's'} applied to reversal debt`, 500)
    : note;
  // The ledger and audit both use the same idempotency key. Always retry the
  // conflict-safe audit insert in case a prior request granted credits but
  // failed before its audit write completed.
  await recordSupportAudit({
    id,
    adminUserId: input.adminUserId,
    targetUserId: input.targetUserId,
    action: 'audiobook_credit_grant',
    resourceId: id,
    amount: Math.floor(input.credits),
    note: auditNote,
  });
  return ledger;
}

export async function updateSupportJob(input: {
  adminUserId: string;
  jobId: string;
  action: 'pause' | 'resume' | 'retry';
  note?: string | null;
}): Promise<SupportJob | null> {
  const currentRows = await db.select({
    id: audiobookJobs.id,
    userId: audiobookJobs.userId,
    status: audiobookJobs.status,
  }).from(audiobookJobs).where(eq(audiobookJobs.id, input.jobId)).limit(1);
  const current = currentRows[0] as { id: string; userId: string; status: string } | undefined;
  if (!current) return null;

  const now = Date.now();
  let values: Record<string, unknown>;
  if (input.action === 'pause') {
    if (!SUPPORT_ACTIVE_JOB_STATUSES.includes(current.status as never) || current.status === 'pausing') {
      throw new Error(`Only active jobs can be paused; this job is ${current.status}.`);
    }
    // A queued/waiting job is idle and can be paused immediately. A running
    // worker must acknowledge the request at its next safe checkpoint so the
    // console never claims that in-flight work has already stopped.
    values = {
      status: current.status === 'running' ? 'pausing' : 'paused',
      updatedAt: now,
    };
  } else if (input.action === 'resume') {
    if (current.status !== 'paused') throw new Error('Only paused jobs can be resumed.');
    values = { status: 'queued', error: null, updatedAt: now };
  } else {
    if (current.status !== 'error') throw new Error('Only failed jobs can be retried.');
    values = {
      status: 'queued',
      error: null,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    };
  }

  const auditInput: SupportAuditInput = {
    adminUserId: input.adminUserId,
    targetUserId: current.userId,
    action: `audiobook_job_${input.action}`,
    resourceId: current.id,
    note: input.note,
  };
  const changedError = `The job changed before it could be ${input.action === 'retry' ? 'retried' : `${input.action}d`}. Refresh and try again.`;
  const updateWhere = and(
    eq(audiobookJobs.id, current.id),
    eq(audiobookJobs.userId, current.userId),
    eq(audiobookJobs.status, current.status),
  );
  if (process.env.POSTGRES_URL) {
    await db.transaction(async (tx: typeof db) => {
      const updatedRows = await tx.update(audiobookJobs).set(values)
        .where(updateWhere).returning({ id: audiobookJobs.id });
      if (updatedRows.length === 0) throw new Error(changedError);
      await recordSupportAudit(auditInput, tx);
    });
  } else {
    db.transaction((tx: typeof db) => {
      const updatedRows = tx.update(audiobookJobs).set(values)
        .where(updateWhere).returning({ id: audiobookJobs.id }).all();
      if (updatedRows.length === 0) throw new Error(changedError);
      recordSupportAuditSync(auditInput, tx);
    });
  }
  if (input.action !== 'pause') {
    runTaskNow('process-audiobook-queue').catch((error) => {
      serverLogger.error({
        event: 'admin.support.queue_wake.failed',
        error: errorToLog(error),
      }, 'Failed to wake the audiobook queue after an admin action');
    });
  }
  const updated = await querySupportJobs({ jobId: current.id, pageSize: 1 });
  return updated.jobs[0] || null;
}

export async function getSupportOverview(): Promise<SupportOverview> {
  const [
    userCountRows,
    documentCountRows,
    audiobookCountRows,
    jobStatusRows,
    requests,
    recentFailures,
    recentAudit,
  ] = await Promise.all([
    db.select({ value: count() }).from(authUser).where(nonAnonymousUserCondition()),
    db.select({ value: count() }).from(documents),
    db.select({ value: count() }).from(audiobooks),
    db.select({ status: audiobookJobs.status, value: count() })
      .from(audiobookJobs).groupBy(audiobookJobs.status),
    listJoinRequests(),
    querySupportJobs({ status: 'error', pageSize: 6 }),
    listSupportAudit({ pageSize: 8 }),
  ]);
  const statusCounts = new Map((jobStatusRows as Array<Record<string, unknown>>)
    .map((row) => [String(row.status), toNumber(row.value)]));
  return {
    userCount: toNumber(userCountRows[0]?.value),
    documentCount: toNumber(documentCountRows[0]?.value),
    audiobookCount: toNumber(audiobookCountRows[0]?.value),
    activeJobCount: SUPPORT_ACTIVE_JOB_STATUSES
      .reduce((total, status) => total + (statusCounts.get(status) || 0), 0),
    failedJobCount: statusCounts.get('error') || 0,
    pendingRequestCount: requests.filter((request) => request.status === 'pending').length,
    recentFailures: recentFailures.jobs,
    recentAudit: recentAudit.events,
  };
}

export async function listSupportSystemLogs(input: {
  limit?: number;
  sinceMs?: number;
  severity?: string;
} = {}) {
  const limit = Math.min(10_000, Math.max(1, Math.floor(input.limit ?? 100)));
  const sinceMs = Number.isFinite(input.sinceMs) && (input.sinceMs || 0) > 0
    ? Math.floor(input.sinceMs || 0)
    : null;
  const severity = boundedText(input.severity, 20);
  const rows = await db.select({
    id: systemLogs.id,
    userId: systemLogs.userId,
    severity: systemLogs.severity,
    context: systemLogs.context,
    message: systemLogs.message,
    details: systemLogs.details,
    createdAt: systemLogs.createdAt,
  }).from(systemLogs)
    .where(and(
      sinceMs === null ? undefined : gte(systemLogs.createdAt, sinceMs),
      severity ? eq(systemLogs.severity, severity) : undefined,
    ))
    .orderBy(desc(systemLogs.createdAt))
    .limit(limit);
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    userId: typeof row.userId === 'string' ? row.userId : null,
    severity: boundedText(row.severity, 20),
    context: boundedText(row.context, 80),
    message: redactSupportDiagnosticText(row.message) || 'No message',
    details: redactSupportLogDetails(row.details),
    createdAt: toMs(row.createdAt),
  }));
}
