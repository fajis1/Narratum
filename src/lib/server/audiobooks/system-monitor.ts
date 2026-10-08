import os from 'node:os';
import fs from 'node:fs/promises';
import { readMemoryHeadroom, requiredMemoryHeadroom } from './memory-headroom';

export interface SystemResourceCheckResult {
  ok: boolean;
  reason?: string;
  details?: {
    memory?: { freeBytes: number; totalBytes: number; freePercent: number; requiredBytes?: number; source?: string };
    cpu?: { load1: number; cores: number; loadRatio: number };
    disk?: { freeBytes: number; totalBytes: number; freePercent: number };
  };
  checkedAt?: number;
}

let cachedResourceCheck: { result: SystemResourceCheckResult; timestamp: number } | null = null;
const CACHE_TTL_MS = 5000; // 5 seconds cache to avoid thrashing fs.statfs during client polls

export function getLastSystemResourceCheck(): SystemResourceCheckResult | null {
  return cachedResourceCheck?.result ?? null;
}

/**
 * Returns true if the system has sufficient free resources (memory, CPU, disk).
 * Thresholds can be configured via environment variables:
 * - AUDIOBOOK_MIN_FREE_DISK_PERCENT (default: 0.20, e.g. 20%)
 * - AUDIOBOOK_MIN_FREE_DISK_GB (optional: minimum required free gigabytes)
 * - Memory default: 20% of effective RAM, capped at 2 GiB; Linux uses MemAvailable and cgroup headroom.
 * - AUDIOBOOK_MIN_FREE_MEM_PERCENT (optional: explicit ratio, uncapped for compatibility)
 * - AUDIOBOOK_MIN_FREE_MEM_GB (optional: absolute GiB minimum; overrides percentage)
 * - AUDIOBOOK_MAX_CPU_LOAD_RATIO (default: 0.80, e.g. 80%)
 */
export async function checkSystemResources(options?: { forceFresh?: boolean }): Promise<SystemResourceCheckResult> {
  if (process.env.ENABLE_TEST_NAMESPACE === 'true' || process.env.AUDIOBOOK_DISABLE_RESOURCE_CHECK === 'true') {
    return { ok: true, checkedAt: Date.now() };
  }

  const now = Date.now();
  if (!options?.forceFresh && cachedResourceCheck && (now - cachedResourceCheck.timestamp < CACHE_TTL_MS)) {
    return cachedResourceCheck.result;
  }

  try {
    // 1. Check allocatable memory, including the container's effective limit.
    const memory = await readMemoryHeadroom();
    const requiredBytes = requiredMemoryHeadroom(memory.totalBytes);
    const memoryDetails = {
      freeBytes: memory.availableBytes, totalBytes: memory.totalBytes,
      freePercent: memory.availableBytes / memory.totalBytes * 100,
      requiredBytes, source: memory.source,
    };
    if (memory.availableBytes < requiredBytes) {
      const result: SystemResourceCheckResult = {
        ok: false,
        reason: `Memory low: ${(memory.availableBytes / 1024 ** 3).toFixed(2)} GiB available of ${(memory.totalBytes / 1024 ** 3).toFixed(2)} GiB effective RAM; ${(requiredBytes / 1024 ** 3).toFixed(2)} GiB headroom required (${memory.source}).`,
        details: { memory: memoryDetails },
        checkedAt: now,
      };
      cachedResourceCheck = { result, timestamp: now };
      return result;
    }

    // 2. Check CPU (Load average over 1 min should not exceed max ratio of core count, default 80%)
    const maxCpuRatio = Number(process.env.AUDIOBOOK_MAX_CPU_LOAD_RATIO ?? '0.8');
    const cpus = os.cpus().length || 1;
    const load1 = os.loadavg()[0]; // 1 minute load average
    const cpuLoadRatio = load1 / cpus;
    if (cpuLoadRatio > maxCpuRatio) {
      const result: SystemResourceCheckResult = {
        ok: false,
        reason: `CPU load high: ${load1.toFixed(2)} on ${cpus} cores (${(cpuLoadRatio * 100).toFixed(0)}% load, maximum ${(maxCpuRatio * 100).toFixed(0)}% allowed)`,
        details: {
          memory: memoryDetails,
          cpu: { load1, cores: cpus, loadRatio: cpuLoadRatio },
        },
        checkedAt: now,
      };
      cachedResourceCheck = { result, timestamp: now };
      return result;
    }

    // 3. Check Storage Space (default: 20% free)
    // Using fs.statfs on the root or app directory (assuming linux/mac)
    try {
      const stats = await fs.statfs('/');
      const freeSpace = stats.bfree * stats.bsize;
      const totalSpace = stats.blocks * stats.bsize;
      const diskFreeRatio = totalSpace > 0 ? freeSpace / totalSpace : 1;
      const freeGb = freeSpace / 1024 / 1024 / 1024;
      const totalGb = totalSpace / 1024 / 1024 / 1024;

      const minDiskPercent = Number(process.env.AUDIOBOOK_MIN_FREE_DISK_PERCENT ?? '0.2');
      const minDiskGbEnv = process.env.AUDIOBOOK_MIN_FREE_DISK_GB;
      const minRequiredGb = minDiskGbEnv !== undefined ? Number(minDiskGbEnv) : null;

      // If AUDIOBOOK_MIN_FREE_DISK_GB is configured, enforce that minimum GB threshold;
      // otherwise enforce percentage threshold.
      const isDiskSpaceLow = minRequiredGb !== null
        ? freeGb < minRequiredGb
        : diskFreeRatio < minDiskPercent;

      if (isDiskSpaceLow) {
        const thresholdText = minRequiredGb !== null
          ? `${minRequiredGb}GB required`
          : `requires at least ${(minDiskPercent * 100).toFixed(0)}% free`;
        const result: SystemResourceCheckResult = {
          ok: false,
          reason: `Disk space low: ${freeGb.toFixed(2)}GB free of ${totalGb.toFixed(2)}GB (${(diskFreeRatio * 100).toFixed(1)}% free, ${thresholdText})`,
          details: {
            memory: memoryDetails,
            disk: { freeBytes: freeSpace, totalBytes: totalSpace, freePercent: diskFreeRatio * 100 },
          },
          checkedAt: now,
        };
        cachedResourceCheck = { result, timestamp: now };
        return result;
      }
    } catch {
      // Ignored if statfs is not supported
    }

    const result: SystemResourceCheckResult = { ok: true, details: { memory: memoryDetails }, checkedAt: now };
    cachedResourceCheck = { result, timestamp: now };
    return result;
  } catch {
    const result: SystemResourceCheckResult = { ok: false, reason: 'Failed to read system resources', checkedAt: now };
    cachedResourceCheck = { result, timestamp: now };
    return result;
  }
}
