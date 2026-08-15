import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { buildPack } from '../scripts/build-growth-weekly-acquisition-v2.mjs';
import {
  canonicalStringify,
  renderAudioInput,
  validatePack,
} from '../scripts/render-growth-pack.mjs';

const PACK_PATH = resolve(
  'config',
  'growth-media',
  'firstknock-weekly-rights-safe-seed.json',
);

async function canonicalPack() {
  return JSON.parse(await readFile(PACK_PATH, 'utf8'));
}

function wrappedLineCount(value, maxCharacters) {
  let count = 0;
  let line = '';
  for (const word of String(value || '').trim().split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxCharacters || !line) {
      line = candidate;
    } else {
      count += 1;
      line = word;
    }
  }
  return count + (line ? 1 : 0);
}

test('weekly acquisition v2 is reproducible, audible, and platform-distinct', async () => {
  const raw = await canonicalPack();
  const pack = validatePack(structuredClone(raw));
  const rebuilt = buildPack(structuredClone(raw));
  assert.deepEqual(rebuilt, pack);
  assert.equal(pack.batch_id, 'firstknock-weekly-rights-safe-v2-2026-07');
  assert.equal(pack.template.version, '2.0.0');
  assert.equal(pack.output.audio_mode, 'baked_owned_or_licensed');
  assert.equal(pack.output.audio_recipe, 'firstknock-procedural-ui-v1');
  assert.equal(pack.sources.length, 14);
  assert.equal(pack.artifacts.length, 28);
  assert.equal(
    createHash('sha256')
      .update(canonicalStringify(pack))
      .digest('hex'),
    '00e06013561a34a7fc59a7be75093c262a78f83b52d5dff0371b1fdf30bd79d0',
  );

  const byConcept = new Map();
  for (const artifact of pack.artifacts) {
    const pair = byConcept.get(artifact.concept_id) || [];
    pair.push(artifact);
    byConcept.set(artifact.concept_id, pair);
    const blocks = artifact.caption.split(/\n{2,}/);
    assert.equal(blocks.length, 5, artifact.artifact_key);
    assert.match(blocks[1], /\bFirstKnock\b/);
    assert.equal(blocks[3], artifact.disclosure);
    assert.equal(
      blocks[4],
      artifact.platform === 'tiktok'
        ? artifact.cta_label
        : `${artifact.cta_label}: ${artifact.cta_url}`,
    );
    assert.equal(artifact.caption.length <= 2200, true);
    const hookWords = artifact.hook.match(/[a-z0-9]+/gi) || [];
    assert.equal(hookWords.length >= 4 && hookWords.length <= 7, true);
    assert.equal(
      wrappedLineCount(artifact.hook.toUpperCase(), 20) <= 2,
      true,
      `${artifact.artifact_key} must render its complete hook`,
    );
    assert.equal(artifact.overlay_text.length, 3);
  }
  assert.equal(byConcept.size, 14);
  for (const pair of byConcept.values()) {
    assert.equal(pair.length, 2);
    assert.deepEqual(
      pair.map((artifact) => artifact.platform).sort(),
      ['instagram', 'tiktok'],
    );
    assert.equal(new Set(pair.map((artifact) => artifact.hook)).size, 2);
    assert.equal(
      new Set(pair.map((artifact) => canonicalStringify(
        artifact.overlay_text,
      ))).size,
      2,
    );
  }
  assert.equal(
    pack.artifacts.filter((artifact) => artifact.hook.includes('?')).length >= 7,
    true,
  );
  assert.equal(
    pack.artifacts.filter(
      (artifact) => /^review\b/i.test(artifact.overlay_cta),
    ).length <= 3,
    true,
  );

  const instagramAudio = renderAudioInput(
    pack.output,
    { platform: 'instagram' },
    '8.000',
  );
  const tiktokAudio = renderAudioInput(
    pack.output,
    { platform: 'tiktok' },
    '8.000',
  );
  assert.match(instagramAudio, /^aevalsrc=/);
  assert.match(tiktokAudio, /^aevalsrc=/);
  assert.notEqual(instagramAudio, tiktokAudio);
  assert.match(instagramAudio, /:s=48000:d=8\.000$/);
});
