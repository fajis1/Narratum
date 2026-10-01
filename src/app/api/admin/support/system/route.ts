import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/server/auth/admin';
import { listSupportSystemLogs } from '@/lib/server/admin/support';
import { listTasks } from '@/lib/server/tasks/engine';
import { getTaskSchedulerInfo } from '@/lib/server/tasks/scheduler';

export const dynamic = 'force-dynamic';

const LOG_RANGE_HOURS = [1, 2, 3, 5, 10, 24, 72, 168] as const;

function requestedLogRangeHours(value: string | null): number {
  const hours = Number(value);
  return LOG_RANGE_HOURS.includes(hours as typeof LOG_RANGE_HOURS[number]) ? hours : 24;
}

export async function GET(req: NextRequest) {
  const ctx = await requireAdminContext(req);
  if (ctx instanceof Response) return ctx;
  const rangeHours = requestedLogRangeHours(req.nextUrl.searchParams.get('hours'));
  const sinceMs = Date.now() - (rangeHours * 60 * 60 * 1_000);
  if (req.nextUrl.searchParams.get('format') === 'download') {
    const logs = await listSupportSystemLogs({ limit: 10_000, sinceMs, severity: 'error' });
    return NextResponse.json({
      generatedAt: Date.now(),
      rangeHours,
      severity: 'error',
      logs,
    }, {
      headers: {
        'Content-Disposition': `attachment; filename="openreader-error-logs-last-${rangeHours}h.json"`,
        'Cache-Control': 'no-store',
      },
    });
  }
  const [logs, tasks] = await Promise.all([
    listSupportSystemLogs({ limit: 500, sinceMs }),
    listTasks(),
  ]);
  return NextResponse.json({ logs, tasks, scheduler: getTaskSchedulerInfo(), rangeHours });
}
