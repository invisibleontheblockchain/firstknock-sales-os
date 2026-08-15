#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalStringify,
  validatePack,
} from './render-growth-pack.mjs';

const DEFAULT_PACK = resolve(
  'config',
  'growth-media',
  'firstknock-weekly-rights-safe-seed.json',
);

const CREATIVE = Object.freeze({
  'fk-rs-route-start-finish-01': {
    title: 'Plan the complete route loop',
    instagram: {
      hook: 'Plan the whole trip before driving',
      overlay_text: [
        'Choose the start',
        'Confirm the finish',
        'Generate the route loop',
      ],
      problem:
        'A route is harder to use when the start and return are decided after it is built.',
      behavior:
        'FirstKnock shows Home Base or current location for the start and keeps Home Base visible as the finish.',
      benefit: 'Set the complete route loop before generating it.',
      cta_label: 'See the route workflow',
      overlay_cta: 'Build your first route',
    },
    tiktok: {
      hook: 'Where should this route start?',
      overlay_text: [
        'Home or current location?',
        'Home Base on the return',
        'Generate when it fits',
      ],
      problem: 'A route needs a clear start and return.',
      behavior:
        'FirstKnock shows the start options and keeps Home Base visible as the finish.',
      benefit: 'Set the full loop before generating.',
      cta_label: 'Try FirstKnock',
      overlay_cta: 'Link in bio',
    },
  },
  'fk-rs-outcome-controls-01': {
    title: 'Keep every knock outcome on the stop',
    instagram: {
      hook: 'What happened at every door?',
      overlay_text: [
        'Choose the outcome',
        'Keep details nearby',
        'Leave a clear next step',
      ],
      problem: 'A door can disappear from the workflow when its outcome is never recorded.',
      behavior:
        'FirstKnock keeps Sold, No Answer, Callback, Not Interested, Not Moved In, and Do Not Knock controls on the stop.',
      benefit: 'Give every knock a visible status and next step.',
      cta_label: 'See the field workflow',
      overlay_cta: 'Try the knock workflow',
    },
    tiktok: {
      hook: 'Every knock needs a next step',
      overlay_text: [
        'Sold or no answer?',
        'Callback or follow-up?',
        'Keep it on the stop',
      ],
      problem: 'Door outcomes should not live in memory.',
      behavior:
        'FirstKnock keeps six outcome choices and Add Details on the stop.',
      benefit: 'Leave every knock with a next step.',
      cta_label: 'Try FirstKnock',
      overlay_cta: 'Link in bio',
    },
  },
  'fk-rs-route-command-01': {
    title: 'Run every route from one command center',
    instagram: {
      hook: 'One command center for every route',
      overlay_text: [
        'See active routes',
        'Open merge controls',
        'Keep the queue visible',
      ],
      problem: 'The next route action is easy to miss when route controls are spread across the workflow.',
      behavior:
        'FirstKnock groups the demo route count, Select to Merge, and queued count inside Route Command.',
      benefit: 'Keep the next route action visible in one place.',
      cta_label: 'See Route Command',
      overlay_cta: 'Open the full demo',
    },
    tiktok: {
      hook: 'Stop hunting for the next route',
      overlay_text: [
        'Active routes',
        'Merge controls',
        'Queue in one view',
      ],
      problem: 'The next route action should be easy to find.',
      behavior:
        'FirstKnock groups the demo route count, merge controls, and the queue in Route Command.',
      benefit: 'Keep the next action in one view.',
      cta_label: 'See the demo',
      overlay_cta: 'Link in bio',
    },
  },
  'fk-rs-merge-routes-01': {
    title: 'Bring selected routes into one plan',
    instagram: {
      hook: 'Two route lists, one field plan',
      overlay_text: [
        'Select the routes',
        'Review the count',
        'Choose Merge',
      ],
      problem: 'Separate route lists can make one field plan harder to review.',
      behavior:
        'FirstKnock shows the selected-route count changing before the Merge action begins.',
      benefit: 'Confirm the exact route selection before bringing it together.',
      cta_label: 'See the merge workflow',
      overlay_cta: 'Build one field plan',
    },
    tiktok: {
      hook: 'Need these routes in one list?',
      overlay_text: [
        'Pick the routes',
        'Check the count',
        'Merge when ready',
      ],
      problem: 'Separate routes can split one field plan.',
      behavior:
        'FirstKnock shows route selection and Merge in the same control.',
      benefit: 'Review the choice before merging.',
      cta_label: 'See the demo',
      overlay_cta: 'Link in bio',
    },
  },
  'fk-rs-bulk-reknock-01': {
    title: 'Queue the doors that need another pass',
    instagram: {
      hook: 'Turn selected stops into another pass',
      overlay_text: [
        'Select the stops',
        'Choose Re-Knock',
        'Queue the next pass',
      ],
      problem: 'Follow-up doors can pile up after a route without a clear next pass.',
      behavior:
        'FirstKnock shows selected demo stops, the Re-Knock action, and its bounded update state together.',
      benefit: 'Move the selected doors into a visible follow-up workflow.',
      cta_label: 'See Re-Knock',
      overlay_cta: 'Build the next pass',
    },
    tiktok: {
      hook: 'Still have doors to re-knock?',
      overlay_text: [
        'Select the doors',
        'Tap Re-Knock',
        'Start the next pass',
      ],
      problem: 'Follow-up doors need another pass.',
      behavior:
        'FirstKnock shows selected stops and the Re-Knock action together.',
      benefit: 'Queue the doors that remain.',
      cta_label: 'Try FirstKnock',
      overlay_cta: 'Link in bio',
    },
  },
  'fk-rs-rerun-followups-01': {
    title: 'Build the next route from follow-ups',
    instagram: {
      hook: 'Turn follow-ups into the next route',
      overlay_text: [
        'Choose the outcomes',
        'Keep the doors that remain',
        'Build the next route',
      ],
      problem: 'A completed route can still leave callbacks, no answers, and unsold follow-ups behind.',
      behavior:
        'FirstKnock shows those follow-up outcomes as selectable rerun inputs in one workflow.',
      benefit: 'Build the next pass from the doors that still need attention.',
      cta_label: 'See the rerun workflow',
      overlay_cta: 'Build your next route',
    },
    tiktok: {
      hook: 'Still have doors to revisit?',
      overlay_text: [
        'Callbacks',
        'No answers',
        'Build the next route',
      ],
      problem: 'Finished routes can still have follow-ups.',
      behavior:
        'FirstKnock lets you choose follow-up outcomes as rerun inputs.',
      benefit: 'Turn remaining doors into the next pass.',
      cta_label: 'Try FirstKnock',
      overlay_cta: 'Link in bio',
    },
  },
  'fk-rs-add-details-01': {
    title: 'Keep follow-up details with the stop',
    instagram: {
      hook: 'Keep every follow-up on the stop',
      overlay_text: [
        'Add the quick note',
        'Set the callback',
        'Keep Photo Proof nearby',
      ],
      problem: 'Notes, callbacks, and photo reminders can scatter after a knock.',
      behavior:
        'FirstKnock expands Add Details to keep the quick note, callback date and time, and Photo Proof controls together.',
      benefit: 'Keep the visible follow-up context attached to the stop.',
      cta_label: 'See Add Details',
      overlay_cta: 'Keep context together',
    },
    tiktok: {
      hook: 'Where did that callback note go?',
      overlay_text: [
        'Quick note',
        'Callback time',
        'Photo Proof',
      ],
      problem: 'Follow-up details can scatter after a knock.',
      behavior:
        'FirstKnock keeps notes, callbacks, and Photo Proof controls together.',
      benefit: 'Keep the context on the stop.',
      cta_label: 'See the demo',
      overlay_cta: 'Link in bio',
    },
  },
  'fk-rs-sale-correction-01': {
    title: 'Review an accidental sale entry',
    instagram: {
      hook: 'Fix an accidental sale entry clearly',
      overlay_text: [
        'Open Edit sale',
        'Choose Delete',
        'Confirm the correction',
      ],
      problem: 'An accidental sale entry needs a clear correction path in the field record.',
      behavior:
        'FirstKnock shows Edit sale, Delete, confirmation, and the bounded Deleting state without claiming completion.',
      benefit: 'See exactly where the correction starts before changing the record.',
      cta_label: 'See the correction flow',
      overlay_cta: 'Review the correction',
    },
    tiktok: {
      hook: 'Marked a sale by mistake?',
      overlay_text: [
        'Open Edit sale',
        'Choose Delete',
        'Confirm first',
      ],
      problem: 'An accidental sale needs a clear review.',
      behavior:
        'FirstKnock shows Delete and confirmation before the correction begins.',
      benefit: 'See the correction path before acting.',
      cta_label: 'See the demo',
      overlay_cta: 'Link in bio',
    },
  },
  'fk-rs-analytics-date-01': {
    title: 'Review one field day at a time',
    instagram: {
      hook: 'Review one field day at a time',
      overlay_text: [
        'Choose the date',
        'Focus the field activity',
        'Review the visible funnel',
      ],
      problem: 'Period totals can hide what happened during one field day.',
      behavior:
        'FirstKnock filters the demo analytics view to the selected date and its visible activity.',
      benefit: 'Review the day that needs attention without losing it inside the total.',
      cta_label: 'See the analytics workflow',
      overlay_cta: 'Review one field day',
    },
    tiktok: {
      hook: 'Which field day needs attention?',
      overlay_text: [
        'Pick a date',
        'See that day',
        'Review the funnel',
      ],
      problem: 'Totals can hide the day that changed.',
      behavior:
        'FirstKnock filters the demo analytics view by one selected date.',
      benefit: 'Focus on the field day that matters.',
      cta_label: 'See the demo',
      overlay_cta: 'Link in bio',
    },
  },
  'fk-rs-manager-funnel-01': {
    title: 'See every stage of the field funnel',
    instagram: {
      hook: 'See the field funnel, not totals',
      overlay_text: [
        'Doors',
        'Decision-maker conversations',
        'Sales in one card',
      ],
      problem: 'One activity total can hide where the field funnel changes.',
      behavior:
        'FirstKnock places doors, decision-maker conversations, and sales together in one redacted demo card.',
      benefit: 'Review each visible stage before choosing the next coaching question.',
      cta_label: 'See the manager workflow',
      overlay_cta: 'Review the full funnel',
    },
    tiktok: {
      hook: 'Where is the field funnel changing?',
      overlay_text: [
        'Doors',
        'Conversations',
        'Sales',
      ],
      problem: 'One total can hide a changing funnel stage.',
      behavior:
        'FirstKnock shows doors, conversations, and sales in one demo card.',
      benefit: 'Review the visible stages together.',
      cta_label: 'See the demo',
      overlay_cta: 'Link in bio',
    },
  },
  'fk-rs-manager-comparison-01': {
    title: 'Compare the same field signals together',
    instagram: {
      hook: 'Compare the same signals side by side',
      overlay_text: [
        'Open both cards',
        'Use the same signals',
        'Choose what to inspect',
      ],
      problem: 'Separate rep cards make a side-by-side review harder.',
      behavior:
        'FirstKnock places two redacted demo cards with the same visible field signals in one manager view.',
      benefit: 'Compare the cards before deciding what needs a closer look.',
      cta_label: 'See the manager view',
      overlay_cta: 'Compare the field cards',
    },
    tiktok: {
      hook: 'Which rep card needs attention?',
      overlay_text: [
        'Two demo cards',
        'The same signals',
        'One manager view',
      ],
      problem: 'Rep cards are harder to compare in separate views.',
      behavior:
        'FirstKnock places two redacted demo cards in one manager view.',
      benefit: 'Review the same field signals together.',
      cta_label: 'See the demo',
      overlay_cta: 'Link in bio',
    },
  },
  'fk-rs-property-styling-01': {
    title: 'Keep route display controls together',
    instagram: {
      hook: 'Make every route easier to scan',
      overlay_text: [
        'Set the dot display',
        'Choose the path pattern',
        'Keep the route readable',
      ],
      problem: 'Route display choices are easy to lose inside a longer settings flow.',
      behavior:
        'FirstKnock keeps property-dot size, opacity, and fill with route-path pattern, thickness, and opacity controls.',
      benefit: 'Review the visible route display controls in one bounded panel.',
      cta_label: 'See the display controls',
      overlay_cta: 'Make the route readable',
    },
    tiktok: {
      hook: 'Can you scan the route?',
      overlay_text: [
        'Dot size',
        'Path pattern',
        'Display in one panel',
      ],
      problem: 'Route display choices can get buried.',
      behavior:
        'FirstKnock keeps dot and path controls together in one panel.',
      benefit: 'Keep the visible route easy to scan.',
      cta_label: 'See the demo',
      overlay_cta: 'Link in bio',
    },
  },
  'fk-rs-refresh-area-01': {
    title: 'Choose how an old area refreshes',
    instagram: {
      hook: 'Refresh an old area without restarting',
      overlay_text: [
        'Fill the gaps',
        'Use Max Since Last',
        'Choose the next pass',
      ],
      problem: 'A previously pulled area does not always need the same refresh choice.',
      behavior:
        'FirstKnock keeps Fill Gaps, Max Since Last, and the unresolved-follow-up option in one bounded view.',
      benefit: 'Choose how to prepare the area for another pass.',
      cta_label: 'See the refresh workflow',
      overlay_cta: 'Prepare the next pass',
    },
    tiktok: {
      hook: 'Working this area again?',
      overlay_text: [
        'Fill Gaps',
        'Max Since Last',
        'Choose the refresh',
      ],
      problem: 'An old area can need a different refresh.',
      behavior:
        'FirstKnock shows Fill Gaps and Max Since Last in one view.',
      benefit: 'Choose how the next pass starts.',
      cta_label: 'See the demo',
      overlay_cta: 'Link in bio',
    },
  },
  'fk-rs-generation-settings-01': {
    title: 'Set the route target before Generate',
    instagram: {
      hook: 'Set the route target first',
      overlay_text: [
        'Choose the property count',
        'Set value and sold window',
        'Generate when ready',
      ],
      problem: 'Route inputs can change from one field plan to the next.',
      behavior:
        'FirstKnock keeps property count, home-value range, sold-window controls, and Generate inside one demo settings view.',
      benefit: 'Review the visible target before starting route generation.',
      cta_label: 'See the generation workflow',
      overlay_cta: 'Build your first route',
    },
    tiktok: {
      hook: 'What should this route include?',
      overlay_text: [
        'Property count',
        'Value and sold window',
        'Generate',
      ],
      problem: 'Every route can need a different target.',
      behavior:
        'FirstKnock keeps the visible route settings and Generate together.',
      benefit: 'Set the target before generation.',
      cta_label: 'Try FirstKnock',
      overlay_cta: 'Link in bio',
    },
  },
});

function caption(artifact, creative) {
  return [
    creative.problem,
    creative.behavior,
    creative.benefit,
    artifact.disclosure,
    artifact.platform === 'tiktok'
      ? creative.cta_label
      : `${creative.cta_label}: ${artifact.cta_url}`,
  ].join('\n\n');
}

function buildPack(raw) {
  const next = structuredClone(raw);
  next.batch_id = 'firstknock-weekly-rights-safe-v2-2026-07';
  next.template.version = '2.0.0';
  next.template.hook_font_size = 68;
  next.output.audio_mode = 'baked_owned_or_licensed';
  next.output.audio_recipe = 'firstknock-procedural-ui-v1';
  next.artifacts = next.artifacts.map((artifact) => {
    const concept = CREATIVE[artifact.concept_id];
    const creative = concept?.[artifact.platform];
    if (!concept || !creative) {
      throw new Error(`Missing v2 creative for ${artifact.artifact_key}`);
    }
    const updated = {
      ...artifact,
      title: concept.title,
      hook: creative.hook,
      overlay_text: creative.overlay_text,
      caption: '',
      cta_label: creative.cta_label,
      overlay_cta: creative.overlay_cta,
    };
    updated.caption = caption(updated, creative);
    return updated;
  });
  return validatePack(next);
}

function parseArgs(argv) {
  const options = {
    input: DEFAULT_PACK,
    output: DEFAULT_PACK,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--input') options.input = resolve(argv[++index]);
    else if (value === '--output') options.output = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(await readFile(options.input, 'utf8'));
  const pack = buildPack(raw);
  const canonical = canonicalStringify(pack);
  const sha256 = createHash('sha256').update(canonical).digest('hex');
  await writeFile(options.output, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    status: 'built',
    batch_id: pack.batch_id,
    pack_sha256: sha256,
    source_count: pack.sources.length,
    artifact_count: pack.artifacts.length,
    audio_mode: pack.output.audio_mode,
    audio_recipe: pack.output.audio_recipe,
  }, null, 2)}\n`);
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

export { buildPack };
