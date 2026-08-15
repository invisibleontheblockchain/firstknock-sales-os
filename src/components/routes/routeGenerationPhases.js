/**
 * The phases a Precision generation actually passes through, in order.
 *
 * Only phases the app can genuinely observe are listed. Each one is derived from
 * the status the generation reports when it STARTS that work, so a lit phase is a
 * phase that is running — nothing here advances on a timer. Deeper solver stages
 * (route structure, boundary refinement, difficult transitions, final
 * measurement) all happen inside one road-optimization call per route and cannot
 * be seen from the app, so they are represented honestly by the phase that owns
 * them rather than by invented sub-steps.
 *
 * Labels are customer language: no matrices, hierarchy levels or engine names.
 */
export const ROUTE_GENERATION_PHASES = [
    { id: 'prepare', label: 'Preparing properties' },
    { id: 'optimize', label: 'Optimizing street order' },
    { id: 'verify', label: 'Verifying final road mileage' },
    { id: 'save', label: 'Saving route' }
];

/**
 * Map a reported status line to its phase. The status strings are written by the
 * generation flow at the moment each step begins, so this is a read of real
 * progress rather than an estimate.
 */
export function phaseFromStage(stage) {
    const text = String(stage || '');
    if (/^Saving/i.test(text)) return 'save';
    if (/Verifying/i.test(text)) return 'verify';
    if (/Optimizing|Reordering/i.test(text)) return 'optimize';
    return 'prepare';
}

/** Position of a phase in the ordered list, or 0 when it is unknown. */
export function phasePosition(phaseId) {
    const index = ROUTE_GENERATION_PHASES.findIndex((phase) => phase.id === phaseId);
    return index === -1 ? 0 : index;
}