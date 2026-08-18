// A door-to-door day has three states, not two. A knocked door is only
// "finished" when no one ever has to come back to it — a callback or a no-answer
// is still live work and must not disappear into a completed list.
//
// This module stays dependency-free on purpose: it is imported directly by
// node --test, and routeBulkActions pulls in lucide-react through
// outcomeStatus, which that runtime cannot resolve.
export const CHECKLIST_STAGES = Object.freeze({
    TODO: 'todo',
    FOLLOW_UP: 'followup',
    COMPLETED: 'completed',
});

// Visited, but the door still owes the rep another attempt.
export const FOLLOW_UP_STATUSES = Object.freeze([
    'NO_ANSWER',
    'CALLBACK',
    'NOT_MOVED_IN',
    'DM_NOT_HOME',
    'QUALIFIED',
]);

// Terminal outcomes: nobody returns to these today or on a later sweep.
export const COMPLETED_STATUSES = Object.freeze([
    'SOLD',
    'HARD_NO',
]);

const FOLLOW_UP_SET = new Set(FOLLOW_UP_STATUSES);
const COMPLETED_SET = new Set(COMPLETED_STATUSES);

// A manager bulk-move to Re-Knock or Callback writes an ELIGIBLE/CALLBACK log
// with a workflow bucket. Those buckets are the manager's explicit instruction,
// so they outrank the outcome status when placing a stop.
// Values mirror InteractionLog.workflow_bucket, the persisted enum written by
// routeBulkActions.
const BUCKET_STAGES = Object.freeze({
    TODO: CHECKLIST_STAGES.TODO,
    CALLBACK: CHECKLIST_STAGES.FOLLOW_UP,
    RE_KNOCK: CHECKLIST_STAGES.FOLLOW_UP,
});

export function checklistStageFor(status, workflowBucket = null) {
    const bucketStage = workflowBucket ? BUCKET_STAGES[workflowBucket] : null;
    if (bucketStage) return bucketStage;
    if (!status || status === 'ELIGIBLE') return CHECKLIST_STAGES.TODO;
    if (FOLLOW_UP_SET.has(status)) return CHECKLIST_STAGES.FOLLOW_UP;
    if (COMPLETED_SET.has(status)) return CHECKLIST_STAGES.COMPLETED;
    // An unrecognized outcome is never silently retired — a rep would lose the
    // door. Treat it as work still needing a decision.
    return CHECKLIST_STAGES.FOLLOW_UP;
}

export function summarizeChecklistStages(properties = [], stageForProperty) {
    const counts = { todo: 0, followup: 0, completed: 0, total: 0 };
    properties.forEach((property) => {
        counts[stageForProperty(property)] += 1;
        counts.total += 1;
    });
    return counts;
}

export const STAGE_DECISION_OPTIONS = Object.freeze({
    [CHECKLIST_STAGES.FOLLOW_UP]: [
        { value: 'NO_ANSWER', label: 'No Answer' },
        { value: 'CALLBACK', label: 'Callback' },
        { value: 'NOT_MOVED_IN', label: 'Not Moved In' },
        { value: 'DM_NOT_HOME', label: 'DM Not Home' },
        { value: 'QUALIFIED', label: 'Qualified' },
    ],
    [CHECKLIST_STAGES.COMPLETED]: [
        { value: 'SOLD', label: 'Sold' },
        { value: 'HARD_NO', label: 'Not Interested' },
    ],
});