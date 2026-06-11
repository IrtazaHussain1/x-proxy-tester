import { describe, expect, it } from 'vitest';
import {
  floorTo6h,
  computeAttribution,
  computePoolClass,
  computeMaxConsecutiveSameIp,
  percentile,
  type RotationRow,
} from '../../src/services/ip-rotation-aggregation';

// ---------------------------------------------------------------------------
// floorTo6h
// ---------------------------------------------------------------------------

describe('floorTo6h', () => {
  it('aligns exactly on boundary', () => {
    expect(floorTo6h(new Date('2026-06-11T00:00:00.000Z')).toISOString()).toBe('2026-06-11T00:00:00.000Z');
    expect(floorTo6h(new Date('2026-06-11T06:00:00.000Z')).toISOString()).toBe('2026-06-11T06:00:00.000Z');
    expect(floorTo6h(new Date('2026-06-11T12:00:00.000Z')).toISOString()).toBe('2026-06-11T12:00:00.000Z');
    expect(floorTo6h(new Date('2026-06-11T18:00:00.000Z')).toISOString()).toBe('2026-06-11T18:00:00.000Z');
  });

  it('floors mid-bucket times', () => {
    expect(floorTo6h(new Date('2026-06-11T03:45:00.000Z')).toISOString()).toBe('2026-06-11T00:00:00.000Z');
    expect(floorTo6h(new Date('2026-06-11T07:59:59.999Z')).toISOString()).toBe('2026-06-11T06:00:00.000Z');
    expect(floorTo6h(new Date('2026-06-11T13:00:01.000Z')).toISOString()).toBe('2026-06-11T12:00:00.000Z');
    expect(floorTo6h(new Date('2026-06-11T23:59:59.999Z')).toISOString()).toBe('2026-06-11T18:00:00.000Z');
  });

  it('produces the correct next bucket boundary', () => {
    const bucket = floorTo6h(new Date('2026-06-11T05:00:00.000Z'));
    const next = new Date(bucket.getTime() + 6 * 3600 * 1000);
    expect(next.toISOString()).toBe('2026-06-11T06:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function row(overrides: Partial<RotationRow> = {}): RotationRow {
  return {
    ipBefore: '1.1.1.1',
    ipAfter: '2.2.2.2',
    success: true,
    rotationDurationMs: null,
    waitTimeMs: null,
    retryCount: 0,
    statusBefore: 'active',
    wsStatusBefore: 'connected',
    errorMessage: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeAttribution
// ---------------------------------------------------------------------------

describe('computeAttribution', () => {
  it('returns zeros for empty input', () => {
    const r = computeAttribution([]);
    expect(r.commandedIpChangeCount).toBe(0);
    expect(r.sameIpCount).toBe(0);
    expect(r.failedButIpChangedCount).toBe(0);
    expect(r.autoIpChangeCountWithinBucket).toBe(0);
  });

  it('counts commanded change: success=true, ip changed', () => {
    const r = computeAttribution([row({ ipBefore: 'A', ipAfter: 'B', success: true })]);
    expect(r.commandedIpChangeCount).toBe(1);
    expect(r.sameIpCount).toBe(0);
    expect(r.failedButIpChangedCount).toBe(0);
  });

  it('counts same ip: ipBefore == ipAfter', () => {
    const r = computeAttribution([row({ ipBefore: 'A', ipAfter: 'A', success: true })]);
    expect(r.sameIpCount).toBe(1);
    expect(r.commandedIpChangeCount).toBe(0);
  });

  it('counts failed-but-changed: success=false, ip changed', () => {
    const r = computeAttribution([row({ ipBefore: 'A', ipAfter: 'B', success: false })]);
    expect(r.failedButIpChangedCount).toBe(1);
    expect(r.commandedIpChangeCount).toBe(0);
  });

  it('counts within-bucket auto-change: cur.ipBefore != prev.ipAfter', () => {
    const rows: RotationRow[] = [
      row({ ipBefore: 'A', ipAfter: 'B', success: true }),  // prev.ipAfter = B
      row({ ipBefore: 'C', ipAfter: 'D', success: true }),  // cur.ipBefore = C != B → auto
    ];
    const r = computeAttribution(rows);
    expect(r.autoIpChangeCountWithinBucket).toBe(1);
    expect(r.commandedIpChangeCount).toBe(2); // both rows: success + ip changed
  });

  it('does NOT count auto when cur.ipBefore == prev.ipAfter (normal sequence)', () => {
    const rows: RotationRow[] = [
      row({ ipBefore: 'A', ipAfter: 'B', success: true }),
      row({ ipBefore: 'B', ipAfter: 'C', success: true }), // cur.ipBefore = B = prev.ipAfter → no auto
    ];
    const r = computeAttribution(rows);
    expect(r.autoIpChangeCountWithinBucket).toBe(0);
  });

  it('skips auto-change check when either ip is null', () => {
    const rows: RotationRow[] = [
      row({ ipBefore: 'A', ipAfter: null }),
      row({ ipBefore: null, ipAfter: 'C' }),
    ];
    const r = computeAttribution(rows);
    expect(r.autoIpChangeCountWithinBucket).toBe(0);
  });

  it('handles mixed attribution in one pass', () => {
    const rows: RotationRow[] = [
      row({ ipBefore: 'A', ipAfter: 'B', success: true }),   // commanded
      row({ ipBefore: 'B', ipAfter: 'B', success: true }),   // same
      row({ ipBefore: 'B', ipAfter: 'C', success: false }),  // failedChanged; prev.ipAfter=B == cur.ipBefore=B → no auto
      row({ ipBefore: 'X', ipAfter: 'Y', success: true }),   // commanded; prev.ipAfter=C != cur.ipBefore=X → auto
    ];
    const r = computeAttribution(rows);
    expect(r.commandedIpChangeCount).toBe(2);
    expect(r.sameIpCount).toBe(1);
    expect(r.failedButIpChangedCount).toBe(1);
    expect(r.autoIpChangeCountWithinBucket).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computePoolClass
// ---------------------------------------------------------------------------

describe('computePoolClass', () => {
  it('returns Stuck for 0 or 1 distinct IPs', () => {
    expect(computePoolClass(0)).toBe('Stuck');
    expect(computePoolClass(1)).toBe('Stuck');
  });

  it('returns Cycling for 2–5 distinct IPs', () => {
    expect(computePoolClass(2)).toBe('Cycling');
    expect(computePoolClass(5)).toBe('Cycling');
  });

  it('returns Medium for 6–20 distinct IPs', () => {
    expect(computePoolClass(6)).toBe('Medium');
    expect(computePoolClass(20)).toBe('Medium');
  });

  it('returns Healthy for 21+ distinct IPs', () => {
    expect(computePoolClass(21)).toBe('Healthy');
    expect(computePoolClass(100)).toBe('Healthy');
  });
});

// ---------------------------------------------------------------------------
// computeMaxConsecutiveSameIp
// ---------------------------------------------------------------------------

describe('computeMaxConsecutiveSameIp', () => {
  it('returns 0 for empty input', () => {
    expect(computeMaxConsecutiveSameIp([])).toBe(0);
  });

  it('returns 0 when no same-IP rows', () => {
    const rows = [
      row({ ipBefore: 'A', ipAfter: 'B' }),
      row({ ipBefore: 'B', ipAfter: 'C' }),
    ];
    expect(computeMaxConsecutiveSameIp(rows)).toBe(0);
  });

  it('counts a single same-IP row as run of 1', () => {
    expect(computeMaxConsecutiveSameIp([row({ ipBefore: 'A', ipAfter: 'A' })])).toBe(1);
  });

  it('returns the longest consecutive run', () => {
    const rows: RotationRow[] = [
      row({ ipBefore: 'A', ipAfter: 'A' }), // run 1
      row({ ipBefore: 'A', ipAfter: 'A' }), // run 2
      row({ ipBefore: 'A', ipAfter: 'B' }), // break
      row({ ipBefore: 'C', ipAfter: 'C' }), // run 1
    ];
    expect(computeMaxConsecutiveSameIp(rows)).toBe(2);
  });

  it('ignores rows where either IP is null', () => {
    const rows: RotationRow[] = [
      row({ ipBefore: null, ipAfter: null }),
      row({ ipBefore: 'A', ipAfter: 'A' }),
      row({ ipBefore: null, ipAfter: 'A' }),
    ];
    expect(computeMaxConsecutiveSameIp(rows)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// percentile
// ---------------------------------------------------------------------------

describe('percentile', () => {
  it('returns null for empty array', () => {
    expect(percentile([], 95)).toBeNull();
  });

  it('returns the only element for a single-element array', () => {
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
  });

  it('p50 of [1,2,3,4,5] is the median', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it('p95 of 100 values is near the top', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const p95 = percentile(sorted, 95);
    expect(p95).toBeGreaterThanOrEqual(95);
    expect(p95).toBeLessThanOrEqual(100);
  });

  it('p100 returns the last element', () => {
    expect(percentile([10, 20, 30], 100)).toBe(30);
  });
});
