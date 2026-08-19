import React from 'react';
import { Axe, Building2 } from 'lucide-react';

const TOGGLE_BASE = 'flex h-9 min-w-0 shrink items-center gap-1.5 rounded-lg border px-2 text-[10px] font-bold transition-colors';

/**
 * The Remove LLC / New build pair that rides beside the Decisions control on
 * every Run Route view — phone, tablet and desktop share this markup so the row
 * reads the same everywhere.
 *
 * Callers own the display class (`flex`, `hidden sm:flex`, ...) via className;
 * the buttons shrink and truncate so a narrow phone row never pushes the
 * Decisions menu off screen.
 *
 * New build always renders, including at zero. A route with no recent
 * construction is a fact the rep wants to read off the row — silently dropping
 * the control just looks like the feature is missing. Remove LLC keeps its
 * older behaviour of hiding when the route has no business-owned doors.
 */
export default function RouteScopeToggles({
    businessOwnedCount = 0,
    hideBusinessOwned = false,
    onToggleBusinessOwned,
    newBuildCount = 0,
    newBuildsOnly = false,
    onToggleNewBuilds,
    className = '',
}) {
    return (
        <div className={`min-w-0 items-center gap-1.5 ${className}`}>
            {businessOwnedCount > 0 && (
                <button
                    type="button"
                    aria-pressed={hideBusinessOwned}
                    onClick={onToggleBusinessOwned}
                    title={`Hide the ${businessOwnedCount} LLC / business-owned stops on this route`}
                    className={`${TOGGLE_BASE} ${hideBusinessOwned ? 'border-cyan-400/45 bg-cyan-400/10 text-cyan-200' : 'border-white/10 bg-white/[0.06] text-white/65 hover:text-white'}`}
                >
                    <Building2 className="h-3 w-3 shrink-0" />
                    <span className="truncate">{hideBusinessOwned ? 'LLC removed' : `Remove LLC (${businessOwnedCount})`}</span>
                </button>
            )}
            <button
                type="button"
                aria-pressed={newBuildsOnly}
                onClick={onToggleNewBuilds}
                disabled={newBuildCount === 0}
                title={newBuildCount === 0
                    ? 'No stops on this route were built this calendar year or last year'
                    : 'Show only homes built this calendar year or last year'}
                className={`${TOGGLE_BASE} disabled:cursor-not-allowed ${newBuildsOnly ? 'border-yellow-400/45 bg-yellow-400/10 text-yellow-200' : 'border-white/10 bg-white/[0.06] text-white/65 hover:text-white'} ${newBuildCount === 0 ? 'opacity-45' : ''}`}
            >
                <Axe className="h-3 w-3 shrink-0" />
                <span className="truncate">{newBuildsOnly ? `New builds (${newBuildCount})` : `New build (${newBuildCount})`}</span>
            </button>
        </div>
    );
}
