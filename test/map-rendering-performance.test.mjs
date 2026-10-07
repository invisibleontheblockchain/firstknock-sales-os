import assert from 'node:assert/strict';
import test from 'node:test';
import { labelGeometry } from '../src/components/map/labelCanvas.js';
import { reconcileMapPins } from '../src/components/map/reconcileMapPins.js';

function harness() {
    const store = new Map();
    const calls = [];
    const operations = {
        create(entry) {
            calls.push(['create', entry.key]);
            return { setLatLng(point) { calls.push(['move', point]); }, setStyle(style) { calls.push(['style', style]); } };
        },
        remove(marker) { calls.push(['remove', marker]); },
    };
    return { store, calls, update: entries => reconcileMapPins(store, entries, operations) };
}
const door = (n, status = 'ELIGIBLE') => ({ key: String(n), point: [33 + n / 100000, -112], style: { radius: 3, status, stopLabel: { text: n } }, payload: { id: n, status } });

test('1,000-stop route retains every layer and label through unchanged viewport/GPS updates', () => {
    const h = harness();
    const entries = Array.from({ length: 1000 }, (_, n) => door(n));
    assert.equal(h.update(entries).added, 1000);
    const before = [...h.store.values()].map(record => record.marker);
    h.calls.length = 0;
    assert.deepEqual(h.update(entries.map(entry => structuredClone(entry))), { added: 0, removed: 0, moved: 0, styled: 0 });
    assert.deepEqual([...h.store.values()].map(record => record.marker), before);
    assert.equal(h.calls.length, 0);
    assert.equal(h.store.size, 1000);
});

test('pan updates only entering/leaving stops; status and coordinates update in place', () => {
    const h = harness();
    h.update(Array.from({ length: 1000 }, (_, n) => door(n)));
    const retained = h.store.get('500').marker;
    const entries = Array.from({ length: 1000 }, (_, n) => door(n + 25));
    entries[475] = { ...door(500, 'SOLD'), point: [34, -113], payload: { id: 500, status: 'SOLD', route_position: 501 } };
    assert.deepEqual(h.update(entries), { added: 25, removed: 25, moved: 1, styled: 1 });
    assert.equal(h.store.get('500').marker, retained);
    assert.deepEqual(retained.__payload, entries[475].payload);
    assert.equal(h.store.size, 1000);
});

test('fresh click payload does not redraw unchanged pins; empty route removes everything', () => {
    const h = harness();
    h.update([door(1)]);
    const marker = h.store.get('1').marker;
    h.calls.length = 0;
    const payload = { ...door(1).payload, note: 'updated' };
    h.update([{ ...door(1), payload }]);
    assert.equal(marker.__payload, payload);
    assert.equal(h.calls.length, 0);
    assert.equal(h.update([]).removed, 1);
    assert.equal(h.store.size, 0);
});

test('label redraw bounds cover the full number, offset and shadow', () => {
    const measured = [];
    const label = labelGeometry({ x: 100, y: 100 }, { text: 1000, size: 11, weight: 800, offsetY: -5 }, (text, font) => {
        measured.push([text, font]);
        return 28;
    });
    assert.deepEqual(measured, [['1000', '800 11px Arial, sans-serif']]);
    assert.deepEqual(label.min, [81, 79]);
    assert.deepEqual(label.max, [119, 100]);
    assert.equal(label.bottom, 95);
    const centered = labelGeometry({ x: 0, y: 0 }, { text: '<address>', size: 8, centered: true }, () => 36);
    assert.equal(centered.text, '<address>');
    assert.equal(centered.bottom, 4);
    assert.equal(labelGeometry({ x: 0, y: 0 }, null, () => { throw Error('must not measure'); }), null);
});
