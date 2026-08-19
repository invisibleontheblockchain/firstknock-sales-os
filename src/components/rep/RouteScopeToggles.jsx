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
 * Decisions menu off screen. A toggle with nothing to act on is not rendered,
 * and when neither has anything the whole group disappears.
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
    if (businessOwnedCount === 0 && newBuildCount === 0) return null;

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
            {newBuildCount > 0 && (
                <button
                    type="button"
                    aria-pressed={newBuildsOnly}
                    onClick={onToggleNewBuilds}
                    title="Show only homes built this calendar year or last year"
                    className={`${TOGGLE_BASE} ${newBuildsOnly ? 'border-yellow-400/45 bg-yellow-400/10 text-yellow-200' : 'border-white/10 bg-white/[0.06] text-white/65 hover:text-white'}`}
                >
                    <Axe className="h-3 w-3 shrink-0" />
                    <span className="truncate">{newBuildsOnly ? `New builds (${newBuildCount})` : `New build (${newBuildCount})`}</span>
                </button>
            )}
        </div>
    );
}
