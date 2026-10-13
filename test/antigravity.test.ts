import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildModelPools } from '../src/providers/antigravity';

test('buildModelPools: 依家族分池，池內以剩餘最少的模型為代表', () => {
  const windows = buildModelPools({
    cascadeModelConfigData: {
      clientModelConfigs: [
        { label: 'Gemini 3 Pro', modelId: 'gemini-3-pro', quotaInfo: { remainingFraction: 0.8 } },
        { label: 'Claude Sonnet', modelId: 'claude-sonnet', quotaInfo: { remainingFraction: 0.9 } },
        {
          label: 'Claude Opus',
          modelId: 'claude-opus',
          quotaInfo: { remainingFraction: 0.25, resetTime: '2026-10-13T15:00:00Z' },
        },
        { label: 'Gemini Flash', modelId: 'gemini-flash', quotaInfo: {} },
      ],
    },
  });
  assert.deepEqual(
    windows.map((w) => [w.label, w.usedPercent]),
    [
      ['Claude pool', 75],
      ['Gemini pool', 20],
    ]
  );
  assert.equal(windows[0]?.resetsAt?.toISOString(), '2026-10-13T15:00:00.000Z');
});

test('buildModelPools: 沒有模型設定時回空陣列', () => {
  assert.deepEqual(buildModelPools({}), []);
});
