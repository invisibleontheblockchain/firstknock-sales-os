// Map-level filter on the outcome recorded for each door, so a manager can see
// just sales or just callbacks without the noise of every route pin.
export const DECISION_FILTERS = [
    { id: 'all', label: 'ALL DOORS', statuses: null },
    { id: 'sold', label: 'SOLD', statuses: ['SOLD'] },
    { id: 'callback', label: 'CALLBACKS', statuses: ['CALLBACK'] },
    { id: 'qualified', label: 'QUALIFIED', statuses: ['QUALIFIED'] },
    { id: 'not_home', label: 'NOT HOME', statuses: ['NO_ANSWER', 'DM_NOT_HOME'] },
    { id: 'not_interested', label: 'NOT INTERESTED', statuses: ['HARD_NO'] },
    { id: 'not_knocked', label: 'NOT KNOCKED', statuses: ['ELIGIBLE', 'OTHER'] },
];

export function matchesDecisionFilter(property, filterId) {
    if (!filterId || filterId === 'all') return true;
    const filter = DECISION_FILTERS.find((option) => option.id === filterId);
    if (!filter?.statuses) return true;
    return filter.statuses.includes(property?.effective_status || 'ELIGIBLE');
}