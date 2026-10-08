import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

const GIB = 1024 ** 3;
type ReadText = (filename: string) => Promise<string>;
export interface MemoryHeadroom {
  totalBytes: number;
  availableBytes: number;
  source: 'os' | 'linux-memavailable' | 'cgroup';
}

function bytes(value: string | null): number | null {
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function optionalRead(read: ReadText, filename: string): Promise<string | null> {
  try { return await read(filename); } catch { return null; }
}

function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/** Resolve the process's memory hierarchy even with a namespaced/nonstandard mount. */
function memoryDirectories(membership: string, mounts: string): Array<{ directory: string; mount: string; v2: boolean }> {
  const result: Array<{ directory: string; mount: string; v2: boolean }> = [];
  for (const line of mounts.split('\n')) {
    const [before, after] = line.split(' - ');
    if (!after) continue;
    const fields = before.split(' ');
    const [kind, , options] = after.split(' ');
    const v2 = kind === 'cgroup2';
    if (!v2 && !(kind === 'cgroup' && options?.split(',').includes('memory'))) continue;
    const member = membership.split('\n').find(entry => {
      const parts = entry.split(':');
      return v2 ? parts[0] === '0' && parts[1] === '' : parts[1]?.split(',').includes('memory');
    });
    if (!member || !fields[3] || !fields[4]) continue;
    const memberPath = member.slice(member.indexOf(':', member.indexOf(':') + 1) + 1);
    const root = unescapeMount(fields[3]);
    const mount = path.posix.normalize(unescapeMount(fields[4]));
    if (!memberPath.startsWith('/') || !mount.startsWith('/')) continue;
    // A private cgroup namespace reports '/' for its mounted root.
    const relative = memberPath === '/' ? '' : root === '/' ? memberPath.slice(1)
      : memberPath === root ? '' : memberPath.startsWith(`${root}/`) ? memberPath.slice(root.length + 1) : null;
    if (relative === null) continue;
    const directory = path.posix.join(mount, relative);
    if (directory !== mount && !directory.startsWith(`${mount}/`)) continue;
    result.push({ directory, mount, v2 });
  }
  return result;
}

/** Available RAM is bounded by both the host and every readable ancestor cgroup. */
export async function readMemoryHeadroom(input: {
  platform?: string; totalBytes?: number; freeBytes?: number; readText?: ReadText;
} = {}): Promise<MemoryHeadroom> {
  const read = input.readText ?? (filename => fs.readFile(filename, 'utf8'));
  let totalBytes = input.totalBytes ?? os.totalmem();
  let availableBytes = input.freeBytes ?? os.freemem();
  let source: MemoryHeadroom['source'] = 'os';
  if ((input.platform ?? process.platform) === 'linux') {
    const [meminfo, membership, mounts] = await Promise.all([
      optionalRead(read, '/proc/meminfo'), optionalRead(read, '/proc/self/cgroup'), optionalRead(read, '/proc/self/mountinfo'),
    ]);
    const availableKb = bytes(meminfo?.match(/^MemAvailable:\s+(\d+)\s+kB$/mu)?.[1] ?? null);
    if (availableKb !== null && Number.isSafeInteger(availableKb * 1024)) {
      availableBytes = availableKb * 1024;
      source = 'linux-memavailable';
    }
    const directories = memoryDirectories(membership ?? '', mounts ?? '');
    // Older/restricted containers may not expose process mount metadata.
    if (!directories.length) directories.push(
      { directory: '/sys/fs/cgroup', mount: '/sys/fs/cgroup', v2: true },
      { directory: '/sys/fs/cgroup/memory', mount: '/sys/fs/cgroup/memory', v2: false },
    );
    for (const hierarchy of directories) {
      let directory = hierarchy.directory;
      for (;;) {
        const limit = bytes(await optionalRead(read, `${directory}/${hierarchy.v2 ? 'memory.max' : 'memory.limit_in_bytes'}`));
        // 'max' and v1's huge unlimited sentinel do not constrain physical RAM.
        if (limit !== null && limit <= (input.totalBytes ?? os.totalmem())) {
          const usage = bytes(await optionalRead(read, `${directory}/${hierarchy.v2 ? 'memory.current' : 'memory.usage_in_bytes'}`));
          if (usage === null) throw new Error('Cannot read usage for the detected container memory limit');
          totalBytes = Math.min(totalBytes, limit);
          availableBytes = Math.min(availableBytes, Math.max(0, limit - usage));
          source = 'cgroup';
        }
        if (directory === hierarchy.mount) break;
        directory = path.posix.dirname(directory);
      }
    }
  }
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(availableBytes) || availableBytes < 0) {
    throw new Error('Invalid memory resource readings');
  }
  return { totalBytes, availableBytes: Math.min(availableBytes, totalBytes), source };
}

/** Explicit GB overrides percentage; explicit percentage retains legacy operator intent. */
export function requiredMemoryHeadroom(totalBytes: number, env: Record<string, string | undefined> = process.env): number {
  const gb = env.AUDIOBOOK_MIN_FREE_MEM_GB;
  const percent = env.AUDIOBOOK_MIN_FREE_MEM_PERCENT;
  if (gb !== undefined && gb.trim()) {
    const value = Number(gb);
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid AUDIOBOOK_MIN_FREE_MEM_GB');
    return value * GIB;
  }
  if (percent !== undefined && percent.trim()) {
    const value = Number(percent);
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid AUDIOBOOK_MIN_FREE_MEM_PERCENT');
    return totalBytes * value;
  }
  return Math.min(totalBytes * 0.2, 2 * GIB);
}
