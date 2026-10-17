import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const toolbar = readFileSync(new URL('../src/components/map/MapToolbar.jsx', import.meta.url), 'utf8');

test('the selected route name starts beside the green button and still truncates', () => {
  // On phones the name button stretches to fill the row; buttons centre their
  // text, so the name needs an explicit left alignment. Desktop sizing is unchanged.
  assert.match(toolbar, /<button onClick=\{handleStartRename\} className="group\/name flex items-center gap-1 min-w-0 flex-1 md:flex-none" title="Rename">/);
  assert.match(toolbar, /<span className="block text-left text-\[11px\] md:text-xs font-bold text-white truncate w-full md:w-auto md:max-w-\[160px\]">/);
});
