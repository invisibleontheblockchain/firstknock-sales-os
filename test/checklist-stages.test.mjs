import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    CHECKLIST_STAGES,
    checklistStageFor,
    summarizeChecklistStages,
} from '../src/components/logic/checklistStages.js';
import { countPropertyVisits, formatRunRouteAge } from '../src/components/logic/outcomeStatus.js';
import { DEFAULT_TODO_ROUTE_FILTERS, matchesTodoRouteFilters } from '../src/components/logic/todoRouteFilters.js';

test('unvisited stops begin in Todo', () => {
    assert.equal(checklistStageFor(null), CHECKLIST_STAGES.TODO);
    assert.equal(checklistStageFor('ELIGIBLE'), CHECKLIST_STAGES.TODO);
});

test('visited stops that still owe a return visit never land in Completed', () => {
    ['NO_ANSWER', 'CALLBACK', 'NOT_MOVED_IN', 'DM_NOT_HOME', 'QUALIFIED'].forEach((status) => {
        assert.equal(
            checklistStageFor(status),
            CHECKLIST_STAGES.FOLLOW_UP,
            `${status} must remain active follow-up work`,
        );
    });
});

test('only sold and not interested are treated as fully completed', () => {
    ['SOLD', 'HARD_NO'].forEach((status) => {
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

test('visit counts include door outcomes but exclude notes and workflow moves', () => {
    assert.equal(countPropertyVisits([
        { parsed_status: 'NO_ANSWER' },
        { parsed_status: 'CALLBACK' },
        { source: 'house_note', description: 'Dog in yard' },
        { parsed_status: 'ELIGIBLE', counts_as_knock: false, workflow_action: 'CLEAR_TO_TODO' },
    ]), 2);
    assert.equal(countPropertyVisits([]), 0);
});

test('Todo routing defaults to every non-terminal outcome', () => {
    assert.deepEqual(DEFAULT_TODO_ROUTE_FILTERS, ['ELIGIBLE', 'NO_ANSWER', 'CALLBACK', 'NOT_MOVED_IN', 'DM_NOT_HOME', 'QUALIFIED']);
    assert.equal(matchesTodoRouteFilters({ effective_status: 'ELIGIBLE' }, DEFAULT_TODO_ROUTE_FILTERS), true);
    assert.equal(matchesTodoRouteFilters({ effective_status: 'NO_ANSWER' }, DEFAULT_TODO_ROUTE_FILTERS), true);
    assert.equal(matchesTodoRouteFilters({ effective_status: 'CALLBACK' }, DEFAULT_TODO_ROUTE_FILTERS), true);
    assert.equal(matchesTodoRouteFilters({ effective_status: 'NOT_MOVED_IN' }, DEFAULT_TODO_ROUTE_FILTERS), true);
    assert.equal(matchesTodoRouteFilters({ effective_status: 'DM_NOT_HOME' }, DEFAULT_TODO_ROUTE_FILTERS), true);
    assert.equal(matchesTodoRouteFilters({ effective_status: 'QUALIFIED' }, DEFAULT_TODO_ROUTE_FILTERS), true);
});

test('Run Route keeps every stop visible with explicit outcome presentation', () => {
    const repHome = readFileSync(new URL('../src/pages/RepHome.jsx', import.meta.url), 'utf8');
    const propertyCard = readFileSync(new URL('../src/components/rep/PropertyCard.jsx', import.meta.url), 'utf8');
    const checklist = readFileSync(new URL('../src/components/routes/RouteChecklist.jsx', import.meta.url), 'utf8');
    const detail = readFileSync(new URL('../src/components/rep/PropertyDetailSheet.jsx', import.meta.url), 'utf8');
    const layout = readFileSync(new URL('../src/Layout.jsx', import.meta.url), 'utf8');
    const toolbar = readFileSync(new URL('../src/components/map/MapToolbar.jsx', import.meta.url), 'utf8');
    const savedRouteLayer = readFileSync(new URL('../src/components/map/savedRouteLayer.js', import.meta.url), 'utf8');
    const managerMapLayers = readFileSync(new URL('../src/components/map/ManagerMapLayers.jsx', import.meta.url), 'utf8');

    assert.match(repHome, /useState\('all'\)/);
    assert.match(repHome, /if \(filterStatus === 'todo'\) return matchesTodoRouteFilters\(p, todoRouteTypes\)/);
    assert.match(repHome, /if \(filterStatus === 'sold'\) return p\.effective_status === 'SOLD'/);
    assert.match(repHome, /if \(filterStatus === 'done'\) return \['SOLD', 'HARD_NO'\]\.includes\(p\.effective_status\)/);
    assert.doesNotMatch(repHome, /selectable=\{filterStatus === 'done'/);
    assert.doesNotMatch(repHome, /Select All.*visible completed stops/s);
    assert.match(repHome, /label: 'All', count: stats\.total/);
    assert.match(checklist, /const \[filter, setFilter\] = useState\('all'\)/);
    assert.match(checklist, /if \(filter === 'todo'\) return matchesTodoRouteFilters\(/);
    assert.match(checklist, /<RouteFunnelTabs/);
    assert.match(checklist, /<TodoRouteFilters/);
    assert.match(checklist, /aria-label=\{`Navigate to \$\{buildFullAddress\(prop\)\}`\}/);
    assert.match(checklist, /\{ id: 'sold', label: 'Sold', count: stats\.sold \}/);
    assert.match(checklist, /propertyStages\[p\.address_hash\] !== CHECKLIST_STAGES\.COMPLETED/);
    assert.match(checklist, /routePositionByHash/);
    assert.match(checklist, /data-radix-scroll-area-viewport/);
    assert.match(checklist, /viewport\.scrollTo\(\{ top: nextTop, behavior: 'smooth' \}\)/);
    assert.match(checklist, /Array\.from\(\{ length: visitCount \}/);
    assert.match(checklist, /Visits:/);
    assert.doesNotMatch(checklist, />\s*Return\s*</);
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
    assert.match(savedRouteLayer, /if \(!style\.showRouteDetails && !hasDecision\) continue/);
    assert.ok(savedRouteLayer.indexOf('// Route lines are added before door pins') < savedRouteLayer.indexOf('// Keep outcome pins visible'));
    assert.match(managerMapLayers, /hasDecision \? outcomeColor\(status\)/);
    assert.doesNotMatch(detail, /FieldRoutes|ScheduleInspectionAction|Schedule Inspection/);
    assert.match(layout, /label="Run Route"/);
    assert.match(toolbar, /RUN ROUTE/);
});