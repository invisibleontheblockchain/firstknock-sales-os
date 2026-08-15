import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflowPath = '.github/workflows/growth-publisher.yml';
const workflow = readFileSync(workflowPath, 'utf8');

test('growth publisher is a guarded five-minute default-branch scheduler', () => {
  assert.match(workflow, /schedule:\s*\n\s*-\s*cron:\s*['"]\*\/5 \* \* \* \*['"]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(workflow, /\bpull_request(?:_target)?:/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /timeout-minutes:\s*3/);
});

test('growth publisher stays inert without both production secrets', () => {
  assert.match(
    workflow,
    /WORKER_URL:\s*\$\{\{\s*secrets\.GROWTH_PUBLISH_WORKER_URL\s*\}\}/,
  );
  assert.match(
    workflow,
    /WORKER_SECRET:\s*\$\{\{\s*secrets\.GROWTH_PUBLISH_WORKER_SECRET\s*\}\}/,
  );
  assert.match(
    workflow,
    /if \[\[ -z "\$WORKER_URL" \|\| -z "\$WORKER_SECRET" \]\]/,
  );
  assert.match(workflow, /configured=false/);
  assert.match(workflow, /steps\.configuration\.outputs\.configured == 'true'/);
});

test('growth publisher binds the exact HTTPS worker and bounded request', () => {
  assert.match(
    workflow,
    /https:\/\/firstknock\.online\/api\/functions\/processGrowthPublishQueue/,
  );
  assert.doesNotMatch(workflow, /\^https:\/\/\[\^\/\?#\]\+/);
  assert.match(workflow, /\$\{#WORKER_SECRET\}\s*<\s*32/);
  assert.match(workflow, /--max-time 120/);
  assert.match(workflow, /--max-filesize 65536/);
  assert.match(workflow, /--request POST/);
  assert.match(workflow, /Authorization: Bearer \$WORKER_SECRET/);
  assert.match(workflow, /--data '\{"limit":1\}'/);
  assert.match(workflow, /body\?\.success !== true/);
  assert.match(workflow, /!Number\.isSafeInteger\(body\?\.inspected\)/);
  assert.match(workflow, /!Number\.isSafeInteger\(body\?\.processed\)/);
  assert.match(workflow, /body\.processed < 0/);
  assert.match(workflow, /body\.inspected < body\.processed/);
  assert.match(workflow, /body\.inspected > 1/);
  assert.doesNotMatch(workflow, /--verbose|-v\b|set -x/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
});
