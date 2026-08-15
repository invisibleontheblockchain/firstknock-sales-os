import React from 'react';
import { Check, Loader2 } from 'lucide-react';
import { ROUTE_GENERATION_PHASES, phasePosition } from './routeGenerationPhases';

/** Ordered phase checklist: done phases are ticked, the running one spins. */
export default function RouteGenerationPhaseList({ phaseId }) {
    const current = phasePosition(phaseId);

    return (
        <div className="w-full space-y-1.5 text-left">
            {ROUTE_GENERATION_PHASES.map((phase, index) => {
                const done = index < current;
                const active = index === current;
                return (
                    <div key={phase.id} className="flex items-center gap-2.5">
                        <span className="flex h-4 w-4 items-center justify-center shrink-0">
                            {done && <Check className="h-3.5 w-3.5" style={{ color: '#2EEB57' }} />}
                            {active && <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: '#D4AF37' }} />}
                            {!done && !active && <span className="h-1.5 w-1.5 rounded-full bg-white/20" />}
                        </span>
                        <span className={`text-xs ${active ? 'font-semibold text-white' : done ? 'text-white/55' : 'text-white/30'}`}>
                            {phase.label}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}