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
    { id: 'CALLBACK', label: 'Callback', icon: Phone, color: '#2EEB57' },
    { id: 'HARD_NO', label: 'Not Int.', icon: Ban, color: '#FF6B6B' },
    { id: 'NOT_MOVED_IN', label: 'Not Moved In', icon: Clock, color: '#F97316' },
    { id: 'DM_NOT_HOME', label: 'DM Not Home', icon: UserX, color: '#D1D5DB' },
];

export const OUTCOME_COLORS = {
    SOLD: '#39FF4A',
    NO_ANSWER: '#FFFFFF',
    CALLBACK: '#2EEB57',
    HARD_NO: '#FF6B6B',
    NOT_MOVED_IN: '#F97316',
    DM_NOT_HOME: '#D1D5DB',
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

// A house note is stored as InteractionLog.description. Outcomes are an
// append-only ledger, so editing a note means appending a newer outcome that
// carries it — the latest row wins, exactly as the knock tab already behaves.
export const latestOutcomeNote = (logs = []) => {
    const withNotes = logs
        .filter((log) => typeof log?.description === 'string' && log.description.trim())
        .sort((a, b) => new Date(b.created_date || 0) - new Date(a.created_date || 0));
    return withNotes[0]?.description?.trim() || '';
};
