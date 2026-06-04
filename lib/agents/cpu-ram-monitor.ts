// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/agents/cpu-ram-monitor — physical-resource gate for heavy spawns.
//
// BACKPORT-02 (2026-05-23) — Ported verbatim from Lazing V2
// `packages/runtime/src/subagent/cpu-ram-monitor.ts` (192 LOC). Pure
// node:os usage; no adaptations needed.

import * as os from 'node:os';

const DEFAULT_MAX_LOAD = 8;
const DEFAULT_MIN_FREE_GB = 1;
const POLL_INTERVAL_MS = 2_000;

export interface OsLike {
  loadavg(): number[];
  freemem(): number;
  totalmem(): number;
}

export interface CpuRamThresholds {
  readonly maxLoad: number;
  readonly minFreeBytes: number;
}

export interface CpuRamSnapshot {
  readonly loadAvg1m: number;
  readonly freeBytes: number;
  readonly totalBytes: number;
  readonly capturedAt: number;
}

export interface CpuRamMonitor {
  snapshot(): CpuRamSnapshot;
  canSpawnHeavy(): boolean;
  reason(): string;
  /** TEST-ONLY — stop the polling interval. */
  __stop(): void;
}

function parsePositiveNumber(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function thresholdsFromEnv(): CpuRamThresholds {
  const maxLoad = parsePositiveNumber(process.env['LAZING_MAX_LOAD'], DEFAULT_MAX_LOAD);
  const minFreeGb = parsePositiveNumber(process.env['LAZING_MIN_FREE_GB'], DEFAULT_MIN_FREE_GB);
  return { maxLoad, minFreeBytes: minFreeGb * 1024 * 1024 * 1024 };
}

export function createCpuRamMonitor(opts?: {
  readonly osLike?: OsLike;
  readonly thresholds?: CpuRamThresholds;
  readonly pollIntervalMs?: number;
}): CpuRamMonitor {
  const osImpl: OsLike = opts?.osLike ?? os;
  const thresholds = opts?.thresholds ?? thresholdsFromEnv();
  const pollMs = opts?.pollIntervalMs ?? POLL_INTERVAL_MS;

  let lastReason = 'no-snapshot-yet';

  const takeSnapshot = (): CpuRamSnapshot => {
    const [load1m = 0] = osImpl.loadavg();
    return {
      loadAvg1m: load1m,
      freeBytes: osImpl.freemem(),
      totalBytes: osImpl.totalmem(),
      capturedAt: Date.now(),
    };
  };

  let current: CpuRamSnapshot = takeSnapshot();

  const tick = (): void => {
    current = takeSnapshot();
  };

  const interval = setInterval(tick, pollMs);
  if (typeof (interval as NodeJS.Timeout).unref === 'function') {
    (interval as NodeJS.Timeout).unref();
  }

  return {
    snapshot(): CpuRamSnapshot {
      return current;
    },
    canSpawnHeavy(): boolean {
      const snap = current;
      if (snap.loadAvg1m > thresholds.maxLoad) {
        lastReason = `loadavg ${snap.loadAvg1m.toFixed(2)} > maxLoad ${thresholds.maxLoad}`;
        return false;
      }
      if (snap.freeBytes < thresholds.minFreeBytes) {
        const freeMb = (snap.freeBytes / (1024 * 1024)).toFixed(0);
        const minMb = (thresholds.minFreeBytes / (1024 * 1024)).toFixed(0);
        lastReason = `freemem ${freeMb} MiB < minFree ${minMb} MiB`;
        return false;
      }
      lastReason = 'within-thresholds';
      return true;
    },
    reason(): string {
      return lastReason;
    },
    __stop(): void {
      clearInterval(interval);
    },
  };
}

let _singleton: CpuRamMonitor | null = null;

export const cpuRamMonitor: CpuRamMonitor = {
  snapshot(): CpuRamSnapshot {
    if (!_singleton) _singleton = createCpuRamMonitor();
    return _singleton.snapshot();
  },
  canSpawnHeavy(): boolean {
    if (process.env['LAZING_DISABLE_CPU_RAM_GATE'] === '1') {
      return true;
    }
    if (!_singleton) _singleton = createCpuRamMonitor();
    return _singleton.canSpawnHeavy();
  },
  reason(): string {
    if (process.env['LAZING_DISABLE_CPU_RAM_GATE'] === '1') {
      return 'gate-disabled-by-env';
    }
    if (!_singleton) _singleton = createCpuRamMonitor();
    return _singleton.reason();
  },
  __stop(): void {
    if (_singleton) {
      _singleton.__stop();
      _singleton = null;
    }
  },
};
