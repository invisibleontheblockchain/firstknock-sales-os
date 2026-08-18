import React from 'react';
import { CheckCircle2, Loader2, MapPinned, X } from 'lucide-react';
import { useFirstAreaWalkthrough } from './useFirstAreaWalkthrough';

const COPY = {
  draw: ['1 of 3', 'Draw your first area', 'Hold and drag around the neighborhood you want to target, then confirm the shape.'],
  filters: ['2 of 3', 'Choose your Precision targets', 'Set the property count, home value, and sold-date range, then tap Generate.'],
  building: ['2 of 3', 'Building your first route', 'FirstKnock is finding eligible homes and optimizing their real-road order.'],
  ready: ['3 of 3', 'Your first route is ready', 'Open the checklist to follow the stop order and record every knock.'],
};

export default function FirstAreaWalkthrough({ user }) {
  const { active, phase, finish } = useFirstAreaWalkthrough(user);
  if (!active) return null;
  const [count, title, description] = COPY[phase];
  const openChecklist = () => {
    document.querySelector('[data-onboarding="route-checklist"]')?.click();
    finish();
  };

  return (
    <aside className="fixed left-3 right-3 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[3000] rounded-2xl border border-primary/40 bg-card/95 p-4 text-card-foreground shadow-2xl backdrop-blur-xl sm:left-auto sm:right-5 sm:top-auto sm:bottom-24 sm:w-80" aria-live="polite">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
          {phase === 'building' ? <Loader2 className="h-5 w-5 animate-spin" /> : phase === 'ready' ? <CheckCircle2 className="h-5 w-5" /> : <MapPinned className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1"><p className="text-[10px] font-black uppercase tracking-[0.2em] text-primary">Quick start · {count}</p><h2 className="mt-1 text-base font-extrabold">{title}</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p></div>
        <button onClick={finish} className="rounded-full p-1 text-muted-foreground hover:text-foreground" aria-label="Skip walkthrough"><X className="h-4 w-4" /></button>
      </div>
      {phase === 'ready' ? <button onClick={openChecklist} className="mt-3 h-10 w-full rounded-xl bg-primary text-xs font-extrabold text-primary-foreground">OPEN CHECKLIST</button> : phase !== 'building' && <p className="mt-3 text-[10px] font-bold uppercase tracking-wider text-primary">Use the highlighted control to continue</p>}
    </aside>
  );
}