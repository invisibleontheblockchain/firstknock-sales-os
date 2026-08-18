import { Check, Phone, Ban, Home, Clock, UserX } from 'lucide-react';

// Single source of truth for how a logged outcome looks. These values are the
// knock tab's (PropertyDetailSheet) — it is the established surface, so the
// checklist adopts its language rather than either one drifting.
//
// Statuses with no knock-tab equivalent keep their own colour below; they are
// not forced into a knock meaning they do not have.
export const OUTCOME_OPTIONS = [
    { id: 'SOLD', label: 'Sold', icon: Check, color: '#39FF4A' },
    { id: 'NO_ANSWER', label: 'No Answer', icon: Home, color: '#FFFFFF' },
    { id: 'CALLBACK', label: 'Callback', icon: Phone, color: '#A855F7' },
    { id: 'HARD_NO', label: 'Not Int.', icon: Ban, color: '#FF6B6B' },
    { id: 'NOT_MOVED_IN', label: 'Not Moved In', icon: Clock, color: '#F97316' },
    { id: 'DM_NOT_HOME', label: 'DM Not Home', icon: UserX, color: '#FFFFFF' },
];

export const OUTCOME_COLORS = {
    SOLD: '#39FF4A',
    NO_ANSWER: '#FFFFFF',
    CALLBACK: '#A855F7',
    HARD_NO: '#FF6B6B',
    NOT_MOVED_IN: '#F97316',
    DM_NOT_HOME: '#FFFFFF',
    DO_NOT_KNOCK: '#FF6B6B',
    OTHER: '#6b7280',
    // No knock-tab equivalent — these describe route state, not a door outcome.
    ELIGIBLE: '#6b7280',
    QUALIFIED: '#3b82f6',
    RECENT_OFF_MARKET: '#FFD700',
};

export const outcomeColor = (status) => OUTCOME_COLORS[status] || '#6b7280';

// White reads as a surface, not an accent, so it needs its own tint treatment.
export const outcomeTint = (color, alpha = '14') =>
    (color === '#FFFFFF' ? 'rgba(255,255,255,0.055)' : `${color}${alpha}`);

export const outcomeBorder = (color, alpha = '2e') =>
    (color === '#FFFFFF' ? 'rgba(255,255,255,0.14)' : `${color}${alpha}`);

// Compact badge text for a row that is already labelled by colour and position;
// never the only signal that a stop is done.
export const OUTCOME_SHORT_LABELS = {
    NO_ANSWER: 'N/A',
    HARD_NO: 'NO',
    NOT_MOVED_IN: 'NMI',
    DM_NOT_HOME: 'DM',
};

export const outcomeShortLabel = (status) => OUTCOME_SHORT_LABELS[status] || status;

const OUTCOME_LABELS = { ELIGIBLE: 'Todo', ...Object.fromEntries(OUTCOME_OPTIONS.map(({ id, label }) => [id, label])) };
export const outcomeLabel = (status) => OUTCOME_LABELS[status] || String(status || '').replaceAll('_', ' ');

export const formatRunRouteAge = (age) => String(age || '')
    .replace(/^(\d+)d$/, '$1 days ago')
    .replace(/^(\d+)m$/, '$1 mon ago');

// A house note lives on its own non-metered InteractionLog row (source
// 'house_note'), one per house, updated in place. It is durable field knowledge
// a rep may read back months later, so it is deliberately independent of any
// single outcome — and it carries no parsed_status, so it can never change a
// door's decision.
export const HOUSE_NOTE_SOURCE = 'house_note';

// A house note records what a rep learned about a door, never what they decided
// at it. Status derivation must ignore it, or saving a note would silently
// reopen a house that was already sold.
// Matched on source, but also on shape: a row with a note and no decision on it
// is a note whatever its source says. That keeps status derivation correct even
// if a note row is written before the source enum reaches the deployed schema.
export const isHouseNoteLog = (log) => {
    if (!log) return false;
    if (log.source === HOUSE_NOTE_SOURCE) return true;
    return !log.parsed_status && typeof log.description === 'string';
};

export const withoutHouseNotes = (logs) =>
    (Array.isArray(logs) ? logs.filter((log) => !isHouseNoteLog(log)) : []);

export const isVisitOutcomeLog = (log) => Boolean(
    log?.parsed_status
    && log.parsed_status !== 'ELIGIBLE'
    && log.counts_as_knock !== false
    && !log.workflow_action
    && !isHouseNoteLog(log)
);

export const countVisitOutcomes = (logs = []) =>
    (Array.isArray(logs) ? logs.filter(isVisitOutcomeLog).length : 0);

export const findHouseNoteLog = (logs = []) =>
    (Array.isArray(logs) ? logs : [])
        .filter((log) => log?.source === HOUSE_NOTE_SOURCE)
        .sort((a, b) => new Date(b.created_date || 0) - new Date(a.created_date || 0))[0] || null;

export const latestOutcomeNote = (logs = []) => {
    // The dedicated note row wins. Notes attached to older outcomes are still
    // honoured so anything saved before house notes existed keeps showing.
    const noteRow = findHouseNoteLog(logs);
    if (noteRow) return typeof noteRow.description === 'string' ? noteRow.description.trim() : '';

    const withNotes = (Array.isArray(logs) ? logs : [])
        .filter((log) => typeof log?.description === 'string' && log.description.trim())
        .sort((a, b) => new Date(b.created_date || 0) - new Date(a.created_date || 0));
    return withNotes[0]?.description?.trim() || '';
};