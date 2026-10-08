import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readMemoryHeadroom, requiredMemoryHeadroom } from '@/lib/server/audiobooks/memory-headroom';
import { checkSystemResources, getLastSystemResourceCheck } from '@/lib/server/audiobooks/system-monitor';
import os from 'node:os';
import fs from 'node:fs/promises';

const GIB = 1024 ** 3;
const v2Mount = '29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw';
function reader(files: Record<string, string>) {
  return vi.fn(async (filename: string) => {
    if (!(filename in files)) throw new Error('unavailable');
    return files[filename];
  });
}
const probe = (files: Record<string, string>, total = 128, free = 25) => readMemoryHeadroom({
  platform: 'linux', totalBytes: total * GIB, freeBytes: free * GIB, readText: reader(files),
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('audiobook memory headroom', () => {
  it('preserves the small-machine safety reserve but caps large-server requirements', () => {
    expect(requiredMemoryHeadroom(2 * GIB, {})).toBe(0.4 * GIB);
    expect(requiredMemoryHeadroom(4 * GIB, {})).toBe(0.8 * GIB);
    expect(requiredMemoryHeadroom(32 * GIB, {})).toBe(2 * GIB);
    expect(requiredMemoryHeadroom(128 * GIB, {})).toBe(2 * GIB);
  });
  it('honors explicit percent and absolute overrides with absolute taking precedence', () => {
    expect(requiredMemoryHeadroom(128 * GIB, { AUDIOBOOK_MIN_FREE_MEM_PERCENT: '0.2' })).toBe(25.6 * GIB);
    expect(requiredMemoryHeadroom(128 * GIB, { AUDIOBOOK_MIN_FREE_MEM_GB: '1.5', AUDIOBOOK_MIN_FREE_MEM_PERCENT: '0.2' })).toBe(1.5 * GIB);
    expect(requiredMemoryHeadroom(4 * GIB, { AUDIOBOOK_MIN_FREE_MEM_PERCENT: '' })).toBe(0.8 * GIB);
  });
  it.each(['NaN', '-1', 'Infinity', '1.1'])('rejects invalid percentage configuration %s', value => {
    expect(() => requiredMemoryHeadroom(4 * GIB, { AUDIOBOOK_MIN_FREE_MEM_PERCENT: value })).toThrow();
  });
  it('uses Linux available memory including reclaimable cache instead of idle memory', async () => {
    const result = await probe({ '/proc/meminfo': `MemAvailable: ${8 * GIB / 1024} kB\n` }, 32, 0.1);
    expect(result).toEqual({ totalBytes: 32 * GIB, availableBytes: 8 * GIB, source: 'linux-memavailable' });
  });
  it('measures 32 GiB container headroom rather than 128 GiB host capacity', async () => {
    const result = await probe({
      '/proc/self/cgroup': '0::/reader', '/proc/self/mountinfo': v2Mount,
      '/sys/fs/cgroup/reader/memory.max': String(32 * GIB), '/sys/fs/cgroup/reader/memory.current': String(31.5 * GIB),
    });
    expect(result).toEqual({ totalBytes: 32 * GIB, availableBytes: 0.5 * GIB, source: 'cgroup' });
    expect(result.availableBytes).toBeLessThan(requiredMemoryHeadroom(result.totalBytes, {}));
  });
  it('honors tighter ancestor limits and shared ancestor usage', async () => {
    const result = await probe({
      '/proc/self/cgroup': '0::/parent/reader', '/proc/self/mountinfo': v2Mount,
      '/sys/fs/cgroup/parent/reader/memory.max': 'max',
      '/sys/fs/cgroup/parent/memory.max': String(4 * GIB), '/sys/fs/cgroup/parent/memory.current': String(Math.floor(3.8 * GIB)),
    });
    expect(result.totalBytes).toBe(4 * GIB);
    expect(result.availableBytes).toBeCloseTo(0.2 * GIB, -1);
  });
  it('resolves namespaced cgroup mount roots', async () => {
    const result = await probe({
      '/proc/self/cgroup': '0::/', '/proc/self/mountinfo': '29 23 0:26 /lxc/101 /sys/fs/cgroup rw - cgroup2 cgroup rw',
      '/sys/fs/cgroup/memory.max': String(32 * GIB), '/sys/fs/cgroup/memory.current': String(16 * GIB),
    });
    expect(result.totalBytes).toBe(32 * GIB);
    expect(result.availableBytes).toBe(16 * GIB);
  });
  it('supports cgroup v1 and ignores its unlimited sentinel', async () => {
    const result = await probe({
      '/proc/self/cgroup': '5:memory:/reader',
      '/proc/self/mountinfo': '29 23 0:26 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory',
      '/sys/fs/cgroup/memory/reader/memory.limit_in_bytes': String(4 * GIB),
      '/sys/fs/cgroup/memory/reader/memory.usage_in_bytes': String(2 * GIB),
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
    });
    expect(result).toEqual({ totalBytes: 4 * GIB, availableBytes: 2 * GIB, source: 'cgroup' });
  });
  it('never reports more headroom than the pressured host has', async () => {
    const result = await probe({ '/sys/fs/cgroup/memory.max': String(32 * GIB), '/sys/fs/cgroup/memory.current': String(2 * GIB) }, 128, 0.5);
    expect(result.availableBytes).toBe(0.5 * GIB);
  });
  it('handles over-limit usage, missing files, malformed meminfo and non-Linux hosts', async () => {
    expect((await probe({ '/sys/fs/cgroup/memory.max': String(4 * GIB), '/sys/fs/cgroup/memory.current': String(5 * GIB) })).availableBytes).toBe(0);
    expect(await probe({ '/proc/meminfo': 'MemAvailable: invalid kB' })).toEqual({ totalBytes: 128 * GIB, availableBytes: 25 * GIB, source: 'os' });
    const readText = reader({});
    expect(await readMemoryHeadroom({ platform: 'darwin', totalBytes: 4 * GIB, freeBytes: GIB, readText })).toEqual({ totalBytes: 4 * GIB, availableBytes: GIB, source: 'os' });
    expect(readText).not.toHaveBeenCalled();
  });
  it('fails conservatively if a known container limit has unreadable usage', async () => {
    await expect(probe({ '/sys/fs/cgroup/memory.max': String(4 * GIB) })).rejects.toThrow('Cannot read usage');
  });
});

describe('queue resource-check integration', () => {
  beforeEach(() => {
    vi.stubEnv('ENABLE_TEST_NAMESPACE', 'false');
    vi.stubEnv('AUDIOBOOK_DISABLE_RESOURCE_CHECK', 'false');
    vi.stubEnv('AUDIOBOOK_MIN_FREE_MEM_PERCENT', '');
    vi.stubEnv('AUDIOBOOK_MIN_FREE_MEM_GB', '');
    vi.stubEnv('AUDIOBOOK_MAX_CPU_LOAD_RATIO', '0.8');
    vi.stubEnv('AUDIOBOOK_MIN_FREE_DISK_PERCENT', '0.2');
    vi.stubEnv('AUDIOBOOK_MIN_FREE_DISK_GB', '');
    vi.spyOn(os, 'cpus').mockReturnValue([{} as ReturnType<typeof os.cpus>[number]]);
    vi.spyOn(os, 'loadavg').mockReturnValue([0, 0, 0]);
    vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('fixture has no proc filesystem'));
    vi.spyOn(fs, 'statfs').mockResolvedValue({ bfree: 50, bsize: GIB, blocks: 100 } as Awaited<ReturnType<typeof fs.statfs>>);
    vi.spyOn(os, 'totalmem').mockReturnValue(128 * GIB);
    vi.spyOn(os, 'freemem').mockReturnValue(25 * GIB);
  });
  it('allows the reported 128 GiB / 25 GiB server and exposes the actual reserve', async () => {
    const result = await checkSystemResources({ forceFresh: true });
    expect(result.ok).toBe(true);
    expect(result.details?.memory).toMatchObject({ freeBytes: 25 * GIB, totalBytes: 128 * GIB, requiredBytes: 2 * GIB });
  });
  it('pauses a 4 GiB machine below its reserve and recovers on a fresh read', async () => {
    vi.mocked(os.totalmem).mockReturnValue(4 * GIB);
    vi.mocked(os.freemem).mockReturnValue(0.5 * GIB);
    const low = await checkSystemResources({ forceFresh: true });
    expect(low.ok).toBe(false);
    expect(low.reason).toContain('0.80 GiB headroom required');
    vi.mocked(os.freemem).mockReturnValue(GIB);
    expect(await checkSystemResources()).toBe(low);
    expect((await checkSystemResources({ forceFresh: true })).ok).toBe(true);
    expect(getLastSystemResourceCheck()?.ok).toBe(true);
  });
  it('retains CPU and disk protection after memory passes', async () => {
    vi.mocked(os.loadavg).mockReturnValue([1, 0, 0]);
    expect((await checkSystemResources({ forceFresh: true })).reason).toContain('CPU load high');
    vi.mocked(os.loadavg).mockReturnValue([0, 0, 0]);
    vi.stubEnv('AUDIOBOOK_MIN_FREE_DISK_GB', '60');
    expect((await checkSystemResources({ forceFresh: true })).reason).toContain('Disk space low');
  });
  it('keeps the explicit opt-out and rejects malformed memory configuration', async () => {
    vi.stubEnv('AUDIOBOOK_DISABLE_RESOURCE_CHECK', 'true');
    expect((await checkSystemResources({ forceFresh: true })).ok).toBe(true);
    vi.stubEnv('AUDIOBOOK_DISABLE_RESOURCE_CHECK', 'false');
    vi.stubEnv('AUDIOBOOK_MIN_FREE_MEM_GB', 'nonsense');
    expect((await checkSystemResources({ forceFresh: true })).ok).toBe(false);
  });
});
