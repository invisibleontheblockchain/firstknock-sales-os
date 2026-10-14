import React from 'react';

export default function RouteOptimizationResult({ attempt, busy, onRetry }) {
    if (!attempt?.message) return null;
    const changed = attempt.route_changed === true;
    const complete = ['applied', 'no_improvement'].includes(attempt.status);
    return (
        <details key={attempt.finished_at} className={`mt-2 rounded-lg border px-2 py-1 text-[11px] ${complete
            ? 'border-green-500/30 text-green-200' : 'border-amber-400/40 text-amber-200'}`}
            onClick={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()}>
            <summary className="cursor-pointer py-1 font-semibold" aria-live="polite">
                {changed ? `${attempt.stops_reordered || 'Route'} ${attempt.stops_reordered ? 'stops reordered' : 'updated'}` : 'Route unchanged'}
                {!complete ? ' · Review optimization result' : ' · Optimization result'}
            </summary>
            <div className="max-h-48 overflow-y-auto pb-1">
                <p className="whitespace-pre-wrap leading-relaxed">{attempt.message}</p>
                {attempt.mode === 'route_only' && !complete && onRetry && (
                    <button type="button" disabled={busy} onClick={onRetry}
                        className="mt-2 min-h-9 rounded-md border border-amber-400/40 px-3 font-semibold disabled:opacity-50">
                        {busy ? 'Checking driving routes…' : 'Retry route optimization'}
                    </button>
                )}
            </div>
        </details>
    );
}
