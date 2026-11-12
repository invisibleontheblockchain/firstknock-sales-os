import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

// Radix's ScrollArea viewport wraps its children in an inline
// `min-width: 100%; display: table` div. A table grows to its widest
// unbreakable line, so one long street name on a route card pushed every
// card's navigate button, status badge and visits row off the right edge of
// the route checklist. The wrapper only renders a vertical scrollbar, so that
// extra width was never scrollable, only clipped.
test('ScrollArea lays its content out at the viewport width', () => {
  const source = readSource('src/components/ui/scroll-area.jsx');
  const viewport = source.match(/<ScrollAreaPrimitive\.Viewport className="([^"]+)"/);
  assert.ok(viewport, 'ScrollArea renders a Radix viewport with a class list');
  const classes = viewport[1].split(/\s+/);
  for (const override of ['[&>div]:!block', '[&>div]:!w-full', '[&>div]:!min-w-0']) {
    assert.ok(classes.includes(override), `viewport overrides Radix's table wrapper with ${override}`);
  }
});

test('ScrollArea still renders only a vertical scrollbar', () => {
  // A horizontal scrollbar would need Radix's table wrapper to size content
  // wider than the viewport, which the override above removes.
  const source = readSource('src/components/ui/scroll-area.jsx');
  assert.match(source, /<ScrollBar \/>/);
  assert.doesNotMatch(source, /<ScrollBar orientation="horizontal"/);
});

test('the route checklist scrolls its stops in the shared ScrollArea', () => {
  const checklist = readSource('src/components/routes/RouteChecklist.jsx');
  assert.match(checklist, /import \{ ScrollArea \} from "@\/components\/ui\/scroll-area";/);
  assert.match(checklist, /<ScrollArea ref=\{scrollAreaRef\} className="flex-1">/);
});
