import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const distRoot = path.resolve('dist');
assert.ok(fs.existsSync(distRoot), 'dist is missing; run the production build first.');

const textExtensions = new Set(['.css', '.html', '.js', '.json', '.map', '.txt', '.webmanifest', '.xml']);
const files = [];
const visit = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(target);
    else if (textExtensions.has(path.extname(entry.name).toLowerCase())) files.push(target);
  }
};
visit(distRoot);

const stalePattern = /my-to-do-list-81bfaad7|agando/i;
let hasFirstKnockDomain = false;
const staleFiles = [];
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  if (stalePattern.test(content)) staleFiles.push(path.relative(process.cwd(), file));
  if (content.includes('firstknock.online')) hasFirstKnockDomain = true;
}

assert.deepEqual(staleFiles, [], `Built artifact contains stale AGANDO host markers: ${staleFiles.join(', ')}`);
assert.ok(hasFirstKnockDomain, 'Built artifact does not contain the canonical firstknock.online domain.');
console.log(`Validated ${files.length} built text artifacts for the FirstKnock domain.`);
