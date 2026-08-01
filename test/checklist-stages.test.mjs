import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CHECKLIST_STAGES,
    checklistStageFor,
    summarizeChecklistStages,
} from '../src/components/logic/checklistStages.js';

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