import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectProbeWindows,
  combineUsageSources,
  mergeSnapshotFile,
  parseCachedUsageUtilization,
  parseRateLimitInfo,
  parseUsageSnapshot,
} from '../src/providers/claude';

const NOW = new Date('2026-10-13T12:00:00Z');
const minutesAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);

test('parseCachedUsageUtilization: limits[] 優先，舊欄位只補缺', () => {
  const parsed = parseCachedUsageUtilization({
    fetchedAtMs: minutesAgo(1).getTime(),
    utilization: {
      limits: [
        { kind: 'session', percent: 40, resets_at: '2026-10-13T15:00:00Z' },
        { kind: 'weekly_all', percent: 12 },
      ],
      five_hour: { utilization: 99 },
      seven_day_opus: { utilization: 5 },
    },
  });
  assert.ok(parsed);
  assert.deepEqual(
    parsed.windows.map((w) => [w.key, w.usedPercent]),
    [
      ['five_hour', 40],
      ['seven_day', 12],
      ['seven_day_opus', 5],
    ]
  );
  assert.equal(parsed.windows[0]?.resetsAt?.toISOString(), '2026-10-13T15:00:00.000Z');
});

test('parseCachedUsageUtilization: 沒有可用數字時回 null', () => {
  assert.equal(parseCachedUsageUtilization(undefined), null);
  assert.equal(parseCachedUsageUtilization({ utilization: { limits: [{ kind: 'session' }] } }), null);
});

test('parseCachedUsageUtilization: 百分比夾在 0~100', () => {
  const parsed = parseCachedUsageUtilization({ utilization: { five_hour: { utilization: 130 } } });
  assert.equal(parsed?.windows[0]?.usedPercent, 100);
});

test('parseRateLimitInfo: unifiedWindows 的 0~1 比例轉成百分比', () => {
  const windows = parseRateLimitInfo({
    unifiedWindows: {
      five_hour: { utilization: 0.4237, resetsAt: 1_760_000_000 },
      seven_day: { utilization: 0.1 },
    },
  });
  assert.deepEqual(
    windows.map((w) => [w.key, w.usedPercentage]),
    [
      ['five_hour', 42.4],
      ['seven_day', 10],
    ]
  );
  assert.equal(windows[0]?.resetsAt?.getTime(), 1_760_000_000_000);
});

test('parseRateLimitInfo: 沒有 unifiedWindows 時退回單一 rateLimitType', () => {
  const windows = parseRateLimitInfo({ rateLimitType: 'seven_day', utilization: 0.5 });
  assert.deepEqual(windows, [{ key: 'seven_day', usedPercentage: 50, resetsAt: null }]);
});

test('collectProbeWindows: 合併多筆 rate_limit_event，同一視窗取最後一筆', () => {
  const stdout = [
    '{"type":"system"}',
    'not json',
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.2 } }),
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', utilization: 0.3 } }),
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.25 } }),
  ].join('\n');
  assert.deepEqual(
    collectProbeWindows(stdout).map((w) => [w.key, w.usedPercentage]),
    [
      ['five_hour', 25],
      ['seven_day', 30],
    ]
  );
});

test('parseUsageSnapshot: 讀 updated_at（秒）與 used_percentage', () => {
  const parsed = parseUsageSnapshot({
    updated_at: Math.floor(minutesAgo(2).getTime() / 1000),
    five_hour: { used_percentage: 33.3, resets_at: null },
  });
  assert.ok(parsed);
  assert.equal(parsed.windows.length, 1);
  assert.equal(parsed.windows[0]?.key, 'five_hour');
  assert.equal(parsed.dataAt.getTime(), Math.floor(minutesAgo(2).getTime() / 1000) * 1000);
});

test('combineUsageSources: 新來源為主，舊來源只補缺且保留自己的資料時間', () => {
  const fresh = parseUsageSnapshot({
    updated_at: Math.floor(minutesAgo(1).getTime() / 1000),
    five_hour: { used_percentage: 50 },
  });
  const old = parseCachedUsageUtilization({
    fetchedAtMs: minutesAgo(60).getTime(),
    utilization: { five_hour: { utilization: 10 }, seven_day: { utilization: 20 } },
  });
  assert.ok(fresh && old);

  const windows = combineUsageSources([fresh, old], NOW);
  assert.deepEqual(
    windows.map((w) => [w.label, w.usedPercent, w.stale === true]),
    [
      ['Session (5 hr)', 50, false],
      ['Weekly (7 day)', 20, true],
    ]
  );
  assert.ok(!('key' in (windows[0] ?? {})), '合併鍵不應外洩到序列化資料');
});

test('mergeSnapshotFile: 保留其他工具的欄位，移除這次沒拿到的視窗', () => {
  const next = mergeSnapshotFile(
    {
      updated_at: 1,
      source: 'statusline',
      five_hour: { used_percentage: 1 },
      seven_day: { used_percentage: 2 },
      context: { used: 123 },
    },
    [{ key: 'five_hour', usedPercentage: 42, resetsAt: new Date(2_000_000_000_000) }],
    'probe',
    NOW
  );
  assert.deepEqual(next, {
    updated_at: Math.floor(NOW.getTime() / 1000),
    source: 'probe',
    five_hour: { used_percentage: 42, resets_at: 2_000_000_000 },
    context: { used: 123 },
  });
});
