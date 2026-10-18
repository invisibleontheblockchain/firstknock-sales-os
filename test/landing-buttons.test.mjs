import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const jsx = readFileSync(new URL('../src/components/marketing/SatelliteLanding.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/components/marketing/SatelliteLanding.css', import.meta.url), 'utf8');
const block = (re) => jsx.match(re)?.[0] ?? '';
const links = (html) => [...html.matchAll(/<(?:Link|a)\b[^>]*>([\s\S]*?)<\/(?:Link|a)>/g)].map((m) => m[0]);

test('the header keeps Sign in as its only action, still to the same sign-in page', () => {
  const nav = block(/<nav>[\s\S]*?<\/nav>/);
  const actions = links(nav).filter((l) => !/className="brand"/.test(l));
  assert.deepEqual(actions, ['<Link className="btn ghost small" to={signInUrl}>Sign in</Link>']);
  assert.doesNotMatch(nav, /Launch FirstKnock|appEntry/);
  assert.match(jsx, /const \{ appEntry, signInUrl \} = getLandingDestinations\(\{/);
});

test('the hero and closing rows offer Launch FirstKnock and Contact us, without Sign in', () => {
  for (const [name, re] of [['hero', /<section className="hero">[\s\S]*?<\/section>/], ['closing', /<section className="center">[\s\S]*?<\/section>/]]) {
    const cta = block(re).match(/<div className="cta">[\s\S]*?<\/div>/)?.[0] ?? '';
    const texts = links(cta).map((l) => l.replace(/<[^>]+>/g, '').replace(/&#8599;/g, '').trim());
    assert.deepEqual(texts, ['Launch FirstKnock', 'Contact us'], name);
    assert.match(cta, /<Link className="btn primary" to=\{appEntry\}>Launch FirstKnock &#8599;<\/Link>/, name);
    assert.doesNotMatch(cta, /signInUrl|Sign in/, name);
  }
  assert.equal(jsx.match(/Sign in/g).length, 1, 'Sign in appears once, in the header');
});

test('no styles are left for the removed header text link, and the header button never wraps', () => {
  assert.doesNotMatch(css, /nav a\.link/);
  assert.match(css, /\.fk-satellite nav \.btn\.small \{ white-space: nowrap; \}/);
});
