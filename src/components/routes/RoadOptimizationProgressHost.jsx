import React, { useEffect, useState } from 'react';
import { Check, ChevronUp, Loader2, Minus } from 'lucide-react';
import {
    describeEstimate,
    LONG_OPTIMIZATION_AFTER_MS,
    LONG_OPTIMIZATION_STOPS,
    subscribeRoadOptimizationJobs
} from '@/lib/roadOptimizationProgress';
import { watchServerRouteOptimizations } from '@/lib/serverRouteOptimizationJobs';

const GOLD = '#D4AF37';

const formatElapsed = ms => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const miles = value => `${(Math.round(value * 10) / 10).toLocaleString()} mi`;

function routeLine(route) {
    if (route.status === 'waiting') return 'Waiting';
    if (route.status === 'improved') return `Done · ${miles(route.savedMiles)} shorter`;
    if (route.status === 'kept') return 'Done · already the shortest order found';
    if (route.status === 'failed') return 'Kept its order · driving check unavailable';
    const parts = [];
    if (route.passesDone) parts.push(`Pass ${route.passesDone + 1}${route.maxPasses ? ` of up to ${route.maxPasses}` : ''}`);
    else parts.push('First pass');
    if (Number.isFinite(route.checksTotal)) parts.push(`${route.checksDone} of ${route.checksTotal} checks`);
    if (route.savedMiles > 0) parts.push(`${miles(route.savedMiles)} saved so far`);
    return parts.join(' · ');
}

function jobFraction(job) {
    const total = job.routes.length;
    const routeFraction = route => {
        if (['improved', 'kept', 'failed'].includes(route.status)) return 1;
        if (route.status === 'waiting') return 0;
        const checks = Number.isFinite(route.checksTotal) && route.checksTotal > 0 ? route.checksDone / route.checksTotal : 0;
        return Math.min(0.95, 0.15 + 0.8 * checks);
    };
    return job.routes.reduce((sum, route) => sum + routeFraction(route), 0) / total;
}

/**
 * The "this will take a minute" screen for long road optimizations: what is
 * happening, how long it usually takes, and live progress per route.
 */
export default function RoadOptimizationProgressHost() {
    const [jobs, setJobs] = useState([]);
    const [now, setNow] = useState(() => Date.now());
    const [hidden, setHidden] = useState(() => new Set());
    // Jobs finishing in the background start as the pill; tapping it opens them.
    const [opened, setOpened] = useState(() => new Set());
    useEffect(() => subscribeRoadOptimizationJobs(setJobs), []);
    // Server-side background searches: check at start and when the tab returns.
    useEffect(() => {
        const check = () => { if (document.visibilityState !== 'hidden') watchServerRouteOptimizations(); };
        check();
        document.addEventListener('visibilitychange', check);
        return () => document.removeEventListener('visibilitychange', check);
    }, []);
    useEffect(() => {
        if (!jobs.length) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [jobs.length]);

    const visible = jobs.filter(job => job.routes.some(route => route.stops >= LONG_OPTIMIZATION_STOPS)
        || now - job.startedAt >= LONG_OPTIMIZATION_AFTER_MS);
    if (!visible.length) return null;
    const job = visible[visible.length - 1];
    const elapsed = formatElapsed(now - job.startedAt);
    const stops = job.routes.reduce((sum, route) => sum + route.stops, 0);
    const percent = Math.round(jobFraction(job) * 100);

    if (hidden.has(job.id) || (job.finishing && !opened.has(job.id))) {
        return (
            <button type="button" onClick={() => {
                setHidden(prev => { const next = new Set(prev); next.delete(job.id); return next; });
                setOpened(prev => new Set(prev).add(job.id));
            }}
                className="fixed bottom-4 left-4 z-[10000] flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold text-white shadow-xl"
                style={{ background: '#111111', borderColor: 'rgba(212,175,55,0.4)' }}
                aria-label="Show optimization progress">
                <Loader2 className="h-4 w-4 animate-spin" style={{ color: GOLD }} />
                {job.finishing ? 'Saved · improving in the background' : `Optimizing · ${percent}%`} · {elapsed}
                <ChevronUp className="h-4 w-4 text-white/60" />
            </button>
        );
    }

    const multi = job.routes.length > 1;
    const single = job.routes[0];
    return (
        <div role="status" aria-live="polite"
            className="fixed inset-x-0 bottom-0 z-[10000] flex justify-center px-4 pb-4 sm:bottom-6 pointer-events-none">
            <div className="pointer-events-auto w-full max-w-md rounded-2xl border p-5 text-white shadow-2xl"
                style={{ background: '#111111', borderColor: 'rgba(212,175,55,0.35)' }}>
                <div className="flex items-start gap-3">
                    <Loader2 className="mt-0.5 h-6 w-6 shrink-0 animate-spin" style={{ color: GOLD }} />
                    <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-bold uppercase tracking-[0.2em]" style={{ color: GOLD }}>
                            {job.finishing ? (multi ? 'Routes saved' : 'Route saved')
                                : job.title || (multi ? `Optimizing ${job.routes.length} routes` : 'Optimizing your route')}
                        </div>
                        <p className="mt-1 text-sm text-white/85">
                            {job.finishing
                                ? 'Checking the remaining neighborhoods for an even shorter drive.'
                                : `Finding the shortest drive on real roads for ${stops.toLocaleString()} stops. This usually takes ${describeEstimate(job.estimate)}.`}
                        </p>
                    </div>
                </div>

                <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.max(4, percent)}%`, background: GOLD }} />
                </div>
                <div className="mt-2 flex justify-between text-xs text-white/60">
                    <span>{multi
                        ? `${job.routes.filter(route => !['waiting', 'optimizing'].includes(route.status)).length} of ${job.routes.length} routes done`
                        : routeLine(single)}</span>
                    <span className="tabular-nums">{elapsed}</span>
                </div>
                {!multi && Number.isFinite(single.bestMiles) && (
                    <div className="mt-2 text-xs text-white/80">Best so far: {miles(single.bestMiles)}</div>
                )}

                {multi && (
                    <ul className="mt-3 max-h-48 space-y-1.5 overflow-y-auto pr-1 text-xs">
                        {job.routes.map((route, index) => (
                            <li key={index} className="flex items-start gap-2">
                                {['improved', 'kept'].includes(route.status) ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: GOLD }} />
                                    : route.status === 'optimizing' ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" style={{ color: GOLD }} />
                                        : <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/30" />}
                                <span className="min-w-0 flex-1">
                                    <span className="font-semibold text-white/90">{route.name || `Route ${index + 1}`}</span>
                                    <span className="text-white/50"> · {route.stops} stops</span>
                                    <span className="block text-white/60">{routeLine(route)}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}

                {job.background && (
                    <div className="mt-4 flex items-center justify-between gap-3">
                        <span className="text-xs text-white/55">{job.finishing
                            ? 'A shorter order is saved only if nobody changes the route meanwhile.'
                            : 'Your route saves automatically when it’s done.'}</span>
                        <button type="button" onClick={() => {
                            setHidden(prev => new Set(prev).add(job.id));
                            setOpened(prev => { const next = new Set(prev); next.delete(job.id); return next; });
                        }}
                            className="shrink-0 rounded-lg px-3 py-2 text-xs font-bold uppercase tracking-wider"
                            style={{ background: GOLD, color: '#000' }}>
                            Keep working
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
