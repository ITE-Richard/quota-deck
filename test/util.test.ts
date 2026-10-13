import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact } from '../src/logger';
import { expireRolledOverWindows, markStaleness, STALE_AFTER_MS } from '../src/types';
import { quoteWindowsArg } from '../src/util/exec';
import { formatAge } from '../src/util/format';

test('quoteWindowsArg: 一般參數不加引號，含空白或引號的依 MSVCRT 規則引用', () => {
  assert.equal(quoteWindowsArg('--version'), '--version');
  assert.equal(quoteWindowsArg(''), '""');
  assert.equal(quoteWindowsArg('C:\\Program Files\\x.cmd'), '"C:\\Program Files\\x.cmd"');
  assert.equal(quoteWindowsArg('{"disableAllHooks": true}'), '"{\\"disableAllHooks\\": true}"');
  assert.equal(quoteWindowsArg('a b\\'), '"a b\\\\"');
});

test('quoteWindowsArg: 拒絕 cmd.exe 無法安全轉義的字元', () => {
  assert.throws(() => quoteWindowsArg('%PATH%'));
  assert.throws(() => quoteWindowsArg('hi!'));
  assert.throws(() => quoteWindowsArg('a\nb'));
});

test('markStaleness: 超過門檻才標為過期', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  const w = { label: 'x', usedPercent: 1, resetsAt: null };
  assert.equal(markStaleness([w], new Date(now.getTime() - STALE_AFTER_MS + 1000), now)[0]?.stale, undefined);
  assert.equal(markStaleness([w], new Date(now.getTime() - STALE_AFTER_MS - 1000), now)[0]?.stale, true);
});

test('expireRolledOverWindows: 重置時刻已過的視窗百分比改為未知', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  const [expired, alive] = expireRolledOverWindows(
    [
      { label: 'a', usedPercent: 57, resetsAt: new Date('2026-10-13T11:00:00Z') },
      { label: 'b', usedPercent: 10, resetsAt: new Date('2026-10-13T13:00:00Z') },
    ],
    now
  );
  assert.equal(expired?.usedPercent, null);
  assert.equal(expired?.stale, true);
  assert.equal(expired?.raw, 'previous window 57.0%');
  assert.equal(alive?.usedPercent, 10);
});

test('redact: 遮蔽 token 類字串', () => {
  assert.equal(redact('key sk-abcdefghijkl'), 'key <redacted>');
  assert.equal(redact('"csrfToken":"abc123"'), '"csrfToken":"<redacted>"');
});

test('formatAge: 分鐘 / 小時 / 天', () => {
  assert.equal(formatAge(5 * 60_000), '5 min');
  assert.equal(formatAge(90 * 60_000), '1 h 30 min');
  assert.equal(formatAge(26 * 3_600_000), '1 d 2 h');
});
