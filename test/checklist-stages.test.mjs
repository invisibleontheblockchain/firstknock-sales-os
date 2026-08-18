import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    CHECKLIST_STAGES,
    checklistStageFor,
    summarizeChecklistStages,
} from '../src/components/logic/checklistStages.js';
import { formatRunRouteAge } from '../src/components/logic/outcomeStatus.js';

test('unvisited stops are the only ones left in To Do', () => {
    assert.equal(checklistStageFor(null), CHECKLIST_STAGES.TODO);
    assert.equal(checklistStageFor('ELIGIBLE'), CHECKLIST_STAGES.TODO);
});

test('visited stops that still owe a return visit never land in Completed', () => {
    ['NO_ANSWER', 'CALLBACK', 'DM_NOT_HOME', 'QUALIFIED'].forEach((status) => {
        assert.equal(
            checklistStageFor(status),
            CHECKLIST_STAGES.FOLLOW_UP,
            `${status} must remain active follow-up work`,
        );
    });
});

test('only terminal outcomes are treated as fully completed', () => {
    ['SOLD', 'HARD_NO', 'NOT_MOVED_IN'].forEach((status) => {
        assert.equal(checklistStageFor(status), CHECKLIST_STAGES.COMPLETED);
    });
});

test('an unrecognized outcome stays visible as work instead of being retired', () => {
    assert.equal(checklistStageFor('SOME_FUTURE_STATUS'), CHECKLIST_STAGES.FOLLOW_UP);
});

test('a manager workflow bucket outranks the recorded outcome', () => {
    assert.equal(checklistStageFor('ELIGIBLE', 'RE_KNOCK'), CHECKLIST_STAGES.FOLLOW_UP);
    assert.equal(checklistStageFor('CALLBACK', 'TODO'), CHECKLIST_STAGES.TODO);
    assert.equal(checklistStageFor('ELIGIBLE', 'CALLBACK'), CHECKLIST_STAGES.FOLLOW_UP);
});

test('stage counts separate follow-ups from completed work', () => {
    const stages = {
        a: CHECKLIST_STAGES.TODO,
        b: CHECKLIST_STAGES.FOLLOW_UP,
        c: CHECKLIST_STAGES.FOLLOW_UP,
        d: CHECKLIST_STAGES.COMPLETED,
    };
    const counts = summarizeChecklistStages(
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
        (property) => stages[property.id],
    );

    assert.deepEqual(counts, { todo: 1, followup: 2, completed: 1, total: 4 });
});

test('Run Route formats recent sale age in days and older sales in months', () => {
    assert.equal(formatRunRouteAge('6d'), '6 days ago');
    assert.equal(formatRunRouteAge('2m'), '2 mon ago');
});

test('Run Route keeps every stop visible in Todo with explicit outcome presentation', () => {
    const repHome = readFileSync(new URL('../src/pages/RepHome.jsx', import.meta.url), 'utf8');
    const propertyCard = readFileSync(new URL('../src/components/rep/PropertyCard.jsx', import.meta.url), 'utf8');
    const checklist = readFileSync(new URL('../src/components/routes/RouteChecklist.jsx', import.meta.url), 'utf8');
    const detail = readFileSync(new URL('../src/components/rep/PropertyDetailSheet.jsx', import.meta.url), 'utf8');
    const layout = readFileSync(new URL('../src/Layout.jsx', import.meta.url), 'utf8');
    const toolbar = readFileSync(new URL('../src/components/map/MapToolbar.jsx', import.meta.url), 'utf8');
    const savedRouteLayer = readFileSync(new URL('../src/components/map/savedRouteLayer.js', import.meta.url), 'utf8');
    const managerMapLayers = readFileSync(new URL('../src/components/map/ManagerMapLayers.jsx', import.meta.url), 'utf8');

    assert.match(repHome, /if \(filterStatus === 'todo'\) return true/);
    assert.match(checklist, /filter === 'all' \|\| filter === CHECKLIST_STAGES\.TODO/);
    assert.match(propertyCard, /Status: \{outcomeLabel\(property\.effective_status \|\| 'ELIGIBLE'\)\}/);
    assert.match(checklist, /Status: \{outcomeLabel\(currentStatus \|\| 'ELIGIBLE'\)\}/);
    assert.match(propertyCard, /formatRunRouteAge\(age\)/);
    assert.match(checklist, /formatRunRouteAge\(ageLabel\)/);
    assert.match(propertyCard, /contentVisibility: 'auto'/);
    assert.match(propertyCard, /export default React\.memo\(PropertyCard\)/);
    assert.match(repHome, /touch-pan-y overflow-y-auto overscroll-y-contain/);
    assert.doesNotMatch(repHome, /bg-black\/55[\s\S]*?backdrop-blur-2xl/);
    assert.match(detail, /skipCallbackDetails: true/);
    assert.match(detail, /Record callback without details/);
    assert.match(savedRouteLayer, /outcomeColor\(decisionStatus\(property\)\)/);
    assert.match(managerMapLayers, /hasDecision \? outcomeColor\(status\)/);
    assert.doesNotMatch(detail, /FieldRoutes|ScheduleInspectionAction|Schedule Inspection/);
    assert.match(layout, /label="Run Route"/);
    assert.match(toolbar, /RUN ROUTE/);
});