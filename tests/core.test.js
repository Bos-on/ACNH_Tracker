import assert from 'node:assert/strict';
import test from 'node:test';

import { DATA_MAP } from '../data.js';
import { monthsForHemisphere, shiftMonths } from '../schema.js';
import { escapeHtml } from '../ui.js';
import {
  applyFilters,
  createSafeStorage,
  getCollectionAccess,
  getStorageModeNotice,
  getTimeRangeLabel,
  isLeavingAfterMonth,
  normalizeUIState,
  parseBackup,
  serializeBackup,
  setCollectedForIds,
  undoCollectedChanges,
  validateImportFileSize
} from '../core.js';

const all = Object.values(DATA_MAP).flat();
const knownIds = new Set(all.map(item => item.id));

test('HTML escaping protects generated labels and attributes', () => {
  assert.equal(escapeHtml('<b title="x">&</b>'), '&lt;b title=&quot;x&quot;&gt;&amp;&lt;/b&gt;');
});

test('data schema and hemisphere derivation stay consistent', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(DATA_MAP).map(([key, value]) => [key, value.length])), {
    fish: 80,
    bug: 80,
    sea: 40
  });
  assert.equal(knownIds.size, 200);
  for (const item of all) {
    assert.match(item.id, /^(fish|bug|sea)_\d{3}$/);
    assert.ok(item.name);
    assert.ok(Number.isInteger(item.price) && item.price >= 0);
    assert.deepEqual(item.southMonths, shiftMonths(item.northMonths));
    assert.deepEqual(monthsForHemisphere(item, 'south'), item.southMonths);
    for (const month of item.northMonths) assert.ok(month >= 1 && month <= 12);
    for (const hour of item.hours) assert.ok(hour >= 0 && hour <= 23);
    assert.deepEqual([...new Set(item.hours)], item.hours);
    assert.deepEqual([...item.hours].sort((a, b) => a - b), item.hours);
  }
});

test('legacy location filters migrate and unknown values are removed', () => {
  const saved = {
    activeTab: 'bug',
    filters: {
      bug: {
        location: ['绿地（飞行）', '完全未知地点'],
        weather: ['雨天', '不存在天气'],
        hour: 7,
        hourManual: true,
        month: 9,
        status: 'uncollected'
      }
    }
  };
  const state = normalizeUIState(saved, DATA_MAP, new Date(2026, 8, 2, 11));
  assert.deepEqual(state.filters.bug.location, ['绿地']);
  assert.deepEqual(state.filters.bug.weather, ['雨天']);
  assert.equal(state.filters.bug.hour, 7);
  assert.equal(state.filters.bug.hourManual, true);
});

test('safe storage reports read and write failures without throwing', () => {
  const error = new DOMException('blocked', 'SecurityError');
  const storage = createSafeStorage({
    getItem() { throw error; },
    setItem() { throw error; }
  });
  assert.equal(storage.getItem('x').ok, false);
  assert.equal(storage.setItem('x', 'y').ok, false);
});

test('collection access blocks edits and empty exports after a load failure', () => {
  assert.deepEqual(getCollectionAccess(false), { canEdit: true, canExport: true, canImport: true });
  assert.deepEqual(getCollectionAccess(true), { canEdit: false, canExport: false, canImport: true });
});

test('backup round-trips an empty collection', () => {
  const text = serializeBackup(new Set());
  const parsed = parseBackup(text, knownIds);
  assert.equal(parsed.collected.size, 0);
  assert.equal(parsed.dropped, 0);
});

test('backup accepts the legacy array and rejects unknown versions and oversized lists', () => {
  assert.deepEqual([...parseBackup('["fish_001"]', knownIds).collected], ['fish_001']);
  assert.throws(() => parseBackup('{"version":2,"collected":[]}', knownIds), /不支持的备份版本/);
  assert.throws(() => parseBackup(JSON.stringify({ version: 1, collected: Array(201).fill('fish_001') }), knownIds), /数量超出上限/);
  assert.throws(() => parseBackup('{"version":1,"collected":["unknown"]}', knownIds), /没有可识别/);
});

test('import file size is bounded before reading', () => {
  assert.doesNotThrow(() => validateImportFileSize(64 * 1024));
  assert.throws(() => validateImportFileSize(64 * 1024 + 1), /64 KB/);
});

test('bulk undo preserves later edits and excludes no-op ids', () => {
  const current = new Set(['already']);
  const bulk = setCollectedForIds(current, ['already', 'new', 'edited-later'], true);
  assert.deepEqual(bulk.changes, [
    { id: 'new', before: false, after: true },
    { id: 'edited-later', before: false, after: true }
  ]);

  const afterLaterEdit = new Set(bulk.next);
  afterLaterEdit.delete('already');
  afterLaterEdit.delete('edited-later');
  const undo = undoCollectedChanges(afterLaterEdit, bulk.changes);
  assert.deepEqual([...undo.next], []);
  assert.equal(undo.restored, 1);
});

test('filters use explicit query state and do not mutate source data', () => {
  const source = DATA_MAP.fish;
  const result = applyFilters(source, {
    filters: { location: ['河流'], shadowSize: [], month: 1, hour: null, hourManual: true, status: 'uncollected' },
    hemisphere: 'north',
    collected: new Set(['fish_001']),
    sort: { key: 'price', dir: 'desc' }
  });
  assert.ok(result.length > 0);
  assert.ok(result.every(item => item.location === '河流' && item.northMonths.includes(1) && item.id !== 'fish_001'));
  assert.notEqual(result, source);
  assert.ok(result.every((item, index) => index === 0 || result[index - 1].price >= item.price));
});

test('time ranges handle midnight wrapping and empty data', () => {
  assert.equal(getTimeRangeLabel([0, 1, 2, 21, 22, 23]), '21-2时');
  assert.equal(getTimeRangeLabel([21, 22, 23, 0, 1, 2]), '21-2时');
  assert.equal(getTimeRangeLabel([]), '未知');
});

test('leaving badge follows the shown month and wraps at year end', () => {
  // 红目鲫 northMonths [1,2,3,11,12]: March is its last month, but December
  // flows into January, so neither December nor November is a last month.
  const dace = DATA_MAP.fish.find(item => item.id === 'fish_001');
  assert.equal(isLeavingAfterMonth(dace, 'north', 3), true);
  assert.equal(isLeavingAfterMonth(dace, 'north', 2), false);
  assert.equal(isLeavingAfterMonth(dace, 'north', 4), false);
  assert.equal(isLeavingAfterMonth(dace, 'north', 11), false);
  assert.equal(isLeavingAfterMonth(dace, 'north', 12), false);
  // 南半球整体平移半年后，9 月成为最后一个月。
  assert.equal(isLeavingAfterMonth(dace, 'south', 9), true);
  assert.equal(isLeavingAfterMonth(dace, 'south', 8), false);

  // 白斑狗鱼 northMonths [9,10,11,12]: December wraps to January, which it
  // does not have, so December really is its last month.
  const pike = DATA_MAP.fish.find(item => item.id === 'fish_024');
  assert.equal(isLeavingAfterMonth(pike, 'north', 12), true);
  assert.equal(isLeavingAfterMonth(pike, 'north', 11), false);

  const allYear = DATA_MAP.fish.find(item => item.id === 'fish_002');
  assert.equal(isLeavingAfterMonth(allYear, 'north', 12), false);
  assert.equal(isLeavingAfterMonth(allYear, 'north', 1), false);
});

test('file mode explains that browser storage is origin-specific', () => {
  assert.match(getStorageModeNotice('file:'), /HTTP.*不同.*存储/);
  assert.equal(getStorageModeNotice('http:'), '');
});
