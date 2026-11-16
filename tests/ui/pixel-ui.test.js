// Unit tests for the pure helpers in static/pixel-ui.js.  Run: node --test tests/ui
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../../static/pixel-ui.js');

test('summarize ignores bad values and reports median and p90', () => {
  const stats = U.summarize([900, 1100, 1500, 700, 2500, NaN, -5, 0]);
  assert.deepEqual(stats, { count: 5, median: 1100, p90: 2100, best: 700, worst: 2500 });
  assert.equal(U.summarize([]).median, null);
});

test('fmtMs switches units and handles missing values', () => {
  assert.equal(U.fmtMs(842), '842 ms');
  assert.equal(U.fmtMs(1840), '1.84 s');
  assert.equal(U.fmtMs(12400), '12.4 s');
  assert.equal(U.fmtMs(null), '—');
});

test('delayTone buckets reply delays', () => {
  assert.deepEqual([400, 1000, 1500, 2600, null].map(U.delayTone), ['good', 'good', 'ok', 'slow', 'none']);
});

test('fmtBytes and machineLine are human readable', () => {
  assert.equal(U.fmtBytes(3.3e9), '3.3 GB');
  assert.equal(U.fmtBytes(360e6), '360 MB');
  assert.equal(U.fmtBytes(0), '—');
  assert.equal(U.machineLine({ memory_bytes: 18 * 2 ** 30, disk_free_bytes: 41e9 }), '18 GB memory · 41 GB free');
});

test('itemState reflects readiness, running jobs and failures', () => {
  const item = { ready: false, required: true, installed: false, action: 'brain' };
  assert.equal(U.itemState({ ...item, ready: true }).tone, 'ready');
  assert.deepEqual(U.itemState(item), { tone: 'missing', label: 'Not installed' });
  assert.equal(U.itemState({ ...item, installed: true }).label, 'Not running');
  assert.equal(U.itemState(item, { brain: { state: 'running', progress: .634, message: 'Pulling' } }).label, 'Installing 63%');
  assert.equal(U.itemState(item, { brain: { state: 'queued' } }).label, 'Waiting');
  assert.deepEqual(U.itemState(item, { brain: { state: 'error', error: 'disk full' } }), { tone: 'error', label: 'Failed', error: 'disk full' });
  assert.equal(U.itemState({ ready: false, required: false, action: 'voice_stack' }).label, 'Optional');
  assert.equal(U.itemState({ ready: false, optional: true }).label, 'Planned');
});

test('missingActions de-duplicates and can limit to required items', () => {
  const items = [
    { ready: false, action: 'voice_stack' }, { ready: false, action: 'voice_stack' },
    { ready: false, action: 'brain', required: true }, { ready: true, action: null, required: true }, { ready: false, action: null, required: true },
  ];
  assert.deepEqual(U.missingActions(items), ['voice_stack', 'brain']);
  assert.deepEqual(U.missingActions(items, true), ['brain']);
});

test('escapeHtml neutralises markup', () => {
  assert.equal(U.escapeHtml('<img src=x onerror="a()">'), '&lt;img src=x onerror=&quot;a()&quot;&gt;');
});

test('navigation helpers know every screen', () => {
  assert.equal(U.hrefFor('setup'), '/setup');
  assert.equal(U.hrefFor('look'), '/look');
  assert.equal(U.hrefFor('nope'), undefined);
});
