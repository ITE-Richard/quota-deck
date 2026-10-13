import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractRateLimits,
  findLatestRateLimits,
  parseAppServerRateLimits,
  parseCamelLimits,
} from '../src/providers/codex';

test('extractRateLimits: 解析 rollout 內巢狀的 snake_case rate_limits', () => {
  const limits = extractRateLimits({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 57, window_minutes: 300, resets_at: 1_760_000_000 },
        secondary: { used_percent: 12.5, window_minutes: 10080 },
        plan_type: 'plus',
        credits: { has_credits: true, unlimited: false, balance: 3 },
      },
    },
  });
  assert.ok(limits);
  assert.equal(limits.primary?.usedPercent, 57);
  assert.equal(limits.primary?.resetsAt?.getTime(), 1_760_000_000_000);
  assert.equal(limits.secondary?.windowMinutes, 10080);
  assert.equal(limits.planType, 'plus');
  assert.deepEqual(limits.credits, { hasCredits: true, unlimited: false, balance: '3' });
});

test('extractRateLimits: 兩個視窗都沒有數字時回 null', () => {
  assert.equal(extractRateLimits({ rate_limits: { primary: { used_percent: 'x' } } }), null);
});

test('parseCamelLimits: 解析 app-server 的 camelCase 欄位', () => {
  const limits = parseCamelLimits({
    primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 0 },
    planType: 'pro',
  });
  assert.ok(limits);
  assert.equal(limits.primary?.usedPercent, 10);
  assert.equal(limits.primary?.resetsAt, null, 'resetsAt 為 0 視為未知');
  assert.equal(limits.secondary, null);
});

test('parseAppServerRateLimits: 額外限額池、credits 與重置點數', () => {
  const parsed = parseAppServerRateLimits({
    rateLimits: {
      primary: { usedPercent: 37, windowDurationMins: 300 },
      secondary: { usedPercent: 5, windowDurationMins: 10080 },
      planType: 'pro',
      credits: { hasCredits: true, unlimited: true, balance: '0' },
    },
    rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 37 } },
      gpt_reserve: { limitName: 'GPT reserve', primary: { usedPercent: 80 } },
    },
    rateLimitResetCredits: { availableCount: 2 },
  });
  assert.ok(parsed);
  assert.equal(parsed.planName, 'Pro');
  assert.deepEqual(
    parsed.windows.map((w) => [w.label, w.usedPercent]),
    [
      ['5 hours', 37],
      ['Weekly', 5],
      ['GPT reserve', 80],
      ['Credits', null],
      ['Usage reset credits', null],
    ]
  );
});

test('findLatestRateLimits: 從檔尾往前找，略過被截斷的殘行', () => {
  const older = JSON.stringify({ timestamp: '2026-10-13T10:00:00Z', rate_limits: { primary: { used_percent: 1 } } });
  const newer = JSON.stringify({ timestamp: '2026-10-13T11:00:00Z', rate_limits: { primary: { used_percent: 2 } } });
  const text = ['ate_limits":{"primary"', older, newer, '{"rate_limits": broken'].join('\n');
  const found = findLatestRateLimits(text);
  assert.equal(found?.limits.primary?.usedPercent, 2);
  assert.equal(found?.timestamp?.toISOString(), '2026-10-13T11:00:00.000Z');
});
