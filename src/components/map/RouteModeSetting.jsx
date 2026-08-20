import React from 'react';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { hasCanvasAccess } from '@/lib/canvasAccess';
import RouteModeToggle from '@/components/map/RouteModeToggle';

/**
 * Canvas / Precision switch for Map Settings.
 * Self-contained: it owns the same persisted key and broadcast event the map
 * toolbar and route builder already listen to, so switching here keeps every
 * view in step without new plumbing through Home.
 */
export default function RouteModeSetting({ value, onChange }) {
  const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me(), staleTime: 1000 * 60 * 5 });
  const [routeMode, setRouteMode] = React.useState(() => {
    try { return localStorage.getItem('fk_routeMode') || 'precision'; } catch { return 'precision'; }
  });
  const [canvasDraftDirty, setCanvasDraftDirty] = React.useState(false);

  React.useEffect(() => {
    const onModeChanged = (event) => {
      const next = event.detail?.routeMode;
      if (next === 'canvas' || next === 'precision') setRouteMode(next);
    };
    const onDraftDirty = (event) => setCanvasDraftDirty(event?.detail?.dirty === true);
    window.addEventListener('fk-route-mode-changed', onModeChanged);
    window.addEventListener('fk-canvas-draft-dirty-changed', onDraftDirty);
    return () => {
      window.removeEventListener('fk-route-mode-changed', onModeChanged);
      window.removeEventListener('fk-canvas-draft-dirty-changed', onDraftDirty);
    };
  }, []);

  if (!hasCanvasAccess(user)) return null;

  const selectedMode = value || routeMode;
  const selectMode = (nextMode) => {
    if (nextMode === selectedMode) return;
    if (
      selectedMode === 'canvas'
      && canvasDraftDirty
      && !window.confirm('You have unsaved Canvas territory changes. Switching to Precision mode will discard them. Continue?')
    ) return;
    setRouteMode(nextMode);
    if (onChange) {
      onChange(nextMode);
    } else {
      try { localStorage.setItem('fk_routeMode', nextMode); } catch {}
      window.dispatchEvent(new CustomEvent('fk-route-mode-changed', { detail: { routeMode: nextMode } }));
    }
    toast.success(`${nextMode === 'canvas' ? 'Standard' : 'Precision'} mode active`);
  };

  return (
    <div>
      <h4 className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mb-3 mt-1">Route Mode</h4>
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <RouteModeToggle routeMode={selectedMode} onChange={selectMode} className="w-full" />
      <p className="mt-2 text-[9px] text-gray-600 leading-relaxed">
        Standard divides drawn areas into rep territories. Precision pulls property data and builds door routes.
        </p>
      </div>
    </div>
  );
}