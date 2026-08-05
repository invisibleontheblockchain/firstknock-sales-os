import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Home,
  Loader2,
  Map as MapIcon,
  Route as RouteIcon,
  Scissors,
  X,
} from 'lucide-react';
import {
  CircleMarker,
  MapContainer,
  Polyline,
  TileLayer,
  useMap,
} from 'react-leaflet';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';
import { CARTO_ATTRIBUTION } from '@/components/map/mapAttribution';
import {
  buildOptimizedSplitPlan,
  buildSplitRouteRecords,
  getRouteStops,
} from './splitRouteUtils';

const ROUTE_COLORS = [
  '#39FF4A', '#60A5FA', '#F59E0B', '#F472B6', '#A78BFA',
  '#22D3EE', '#FB7185', '#84CC16', '#F97316', '#2DD4BF',
];

function previewColor(index) {
  return ROUTE_COLORS[index % ROUTE_COLORS.length];
}

function defaultMaximum(totalHomes) {
  if (totalHomes <= 1) return 1;
  let savedValue = 25;
  try {
    const parsed = Number(localStorage.getItem('fk_split_max_homes'));
    if (Number.isInteger(parsed) && parsed > 0) savedValue = parsed;
  } catch {
    // Local preferences are optional.
  }
  return Math.min(savedValue, totalHomes - 1);
}

function entityRows(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.items)) return response.items;
  if (Array.isArray(response?.data)) return response.data;
  return [];
}

function FitSplitPreview({ routes }) {
  const map = useMap();
  const points = useMemo(() => routes.flatMap((route) => (
    route.stops.map((stop) => [Number(stop.lat), Number(stop.lng)])
  )), [routes]);
  const signature = points.map((point) => point.join(',')).join('|');

  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) map.setView(points[0], 16, { animate: false });
    else map.fitBounds(points, { padding: [18, 18], maxZoom: 16, animate: false });
    window.setTimeout(() => map.invalidateSize({ animate: false }), 0);
  }, [map, signature]);

  return null;
}

function SplitMapPreview({ routes }) {
  const firstStop = routes[0]?.stops?.[0];
  const center = firstStop
    ? [Number(firstStop.lat), Number(firstStop.lng)]
    : [39.5, -98.35];

  return (
    <div className="h-56 overflow-hidden rounded-2xl border border-white/10 bg-[#111] sm:h-64">
      <MapContainer
        center={center}
        zoom={13}
        className="h-full w-full"
        zoomControl={false}
        scrollWheelZoom={false}
        attributionControl
        preferCanvas
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution={CARTO_ATTRIBUTION}
        />
        <FitSplitPreview routes={routes} />
        {routes.map((route, routeIndex) => {
          const color = previewColor(routeIndex);
          const positions = route.stops.map((stop) => [Number(stop.lat), Number(stop.lng)]);
          return (
            <React.Fragment key={route.code}>
              {positions.length > 1 && (
                <Polyline positions={positions} pathOptions={{ color, opacity: 0.72, weight: 3 }} />
              )}
              {positions.map((position, stopIndex) => (
                <CircleMarker
                  key={`${route.code}-${stopIndex}`}
                  center={position}
                  radius={3.5}
                  pathOptions={{ color: '#070707', fillColor: color, fillOpacity: 1, weight: 1 }}
                />
              ))}
            </React.Fragment>
          );
        })}
      </MapContainer>
    </div>
  );
}

function routeCountCopy(plan) {
  if (!plan) return '';
  const sizeCopy = plan.minHomes === plan.maxHomes
    ? `${plan.minHomes} homes each`
    : `${plan.minHomes}–${plan.maxHomes} homes each`;
  return `${plan.routeCount} optimized routes · ${sizeCopy}`;
}

export default function SplitRouteModal({
  route,
  managerId,
  replaceSource = false,
  onClose,
  onCreated,
}) {
  const totalHomes = getRouteStops(route).length;
  const [sizingMode, setSizingMode] = useState('max_homes');
  const [requestedValue, setRequestedValue] = useState(() => defaultMaximum(totalHomes));
  const [routeNames, setRouteNames] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const planResult = useMemo(() => {
    try {
      return {
        plan: buildOptimizedSplitPlan({ route, sizingMode, value: requestedValue }),
        error: '',
      };
    } catch (error) {
      return { plan: null, error: error?.message || 'This route could not be divided.' };
    }
  }, [route, sizingMode, requestedValue]);
  const plan = planResult.plan;
  const planSignature = plan
    ? `${route?.id || route?.name || 'route'}:${sizingMode}:${requestedValue}:${plan.routeCount}`
    : '';

  useEffect(() => {
    setRouteNames(plan?.routes?.map((child) => child.name) || []);
  }, [planSignature]);

  const trimmedNames = routeNames.map((name) => String(name || '').trim());
  const namesComplete = Boolean(plan)
    && trimmedNames.length === plan.routes.length
    && trimmedNames.every(Boolean);
  const namesUnique = namesComplete && new Set(trimmedNames.map((name) => name.toLowerCase())).size === trimmedNames.length;
  const nameError = !plan || namesComplete
    ? (namesComplete && !namesUnique ? 'Each route needs a unique name.' : '')
    : 'Every route needs a name.';
  const sourceWillBeArchived = Boolean(replaceSource && route?.id);

  const switchSizingMode = (nextMode) => {
    if (nextMode === sizingMode) return;
    if (plan) {
      setRequestedValue(nextMode === 'route_count'
        ? plan.routeCount
        : Math.min(Math.ceil(plan.totalHomes / plan.routeCount), plan.totalHomes - 1));
    } else {
      setRequestedValue(nextMode === 'route_count' ? 2 : defaultMaximum(totalHomes));
    }
    setSizingMode(nextMode);
    setSaveError('');
  };

  const updateRouteName = (index, value) => {
    setRouteNames((current) => current.map((name, nameIndex) => (
      nameIndex === index ? value : name
    )));
  };

  const rollbackCreatedRoutes = async (createdRoutes) => {
    const ids = createdRoutes.map((created) => created?.id).filter(Boolean);
    if (!ids.length || ids.length !== createdRoutes.length) return false;
    const results = await Promise.allSettled(ids.map((id) => base44.entities.SavedRoute.delete(id)));
    return results.every((result) => result.status === 'fulfilled');
  };

  const handleConfirm = async () => {
    if (!plan || !namesComplete || !namesUnique || isSaving) return;
    setIsSaving(true);
    setSaveError('');
    const records = buildSplitRouteRecords({ route, plan, managerId, routeNames: trimmedNames });
    let createdRoutes = [];

    try {
      const createdResponse = await base44.entities.SavedRoute.bulkCreate(records);
      createdRoutes = entityRows(createdResponse);
      let sourceArchived = false;

      if (sourceWillBeArchived) {
        try {
          const archivedAt = new Date().toISOString();
          await base44.entities.SavedRoute.update(route.id, {
            status: 'ARCHIVED',
            assigned_to: null,
            assigned_to_name: null,
            metadata: {
              ...(route.metadata || {}),
              split_replacement: {
                child_route_ids: createdRoutes.map((created) => created?.id).filter(Boolean),
                child_route_names: [...trimmedNames],
                archived_at: archivedAt,
                previous_status: route.status || 'PENDING',
                previous_assigned_to: route.assigned_to || null,
                previous_assigned_to_name: route.assigned_to_name || null,
                sizing_mode: plan.sizingMode,
                requested_value: plan.requestedValue,
              },
            },
          });
          sourceArchived = true;
        } catch (archiveError) {
          const rolledBack = await rollbackCreatedRoutes(createdRoutes);
          if (rolledBack) {
            throw new Error('The original route could not be archived, so the new routes were rolled back. Nothing changed.');
          }
          throw new Error(
            'The new routes were created, but the original route could not be archived. Refresh Routes and review the results before dispatching.',
            { cause: archiveError },
          );
        }
      }

      try {
        if (sizingMode === 'max_homes') {
          localStorage.setItem('fk_split_max_homes', String(requestedValue));
        }
      } catch {
        // Local preferences are optional.
      }

      try {
        await onCreated?.({
          count: records.length,
          createdRoutes,
          sourceRouteId: route?.id || null,
          sourceArchived,
        });
      } catch (callbackError) {
        console.error('[SplitRouteModal] Created routes but failed to refresh the parent view', callbackError);
      }
      onClose?.();
    } catch (error) {
      console.error('[SplitRouteModal] Split failed', error);
      setSaveError(error?.message || 'FirstKnock could not create these routes. Nothing was changed.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[5000] flex items-end justify-center bg-black/75 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[94dvh] w-full max-w-4xl overflow-hidden rounded-t-2xl border border-white/10 bg-[#0A0A0A] text-white shadow-2xl sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-black text-white">
              <Scissors className="h-4 w-4 text-[#39FF4A]" /> Create smaller routes
            </h2>
            <p className="truncate text-xs text-white/45">{route?.name || 'Selected route'} · {totalHomes} homes</p>
          </div>
          <button onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-white/10" aria-label="Close route planner">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[calc(94dvh-140px)] space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
          <div className="rounded-2xl border border-[#2EEB57]/20 bg-[#2EEB57]/[0.06] p-4">
            <p className="text-sm font-black text-white">Divide nearby homes into balanced routes.</p>
            <p className="mt-1 text-xs leading-relaxed text-white/55">
              FirstKnock keeps streets and neighborhoods together when possible. Assign reps and dates afterward.
            </p>
          </div>

          <section className="space-y-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/45">Split by</p>
              <div className="mt-2 grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-1.5">
                <button
                  type="button"
                  aria-pressed={sizingMode === 'max_homes'}
                  onClick={() => switchSizingMode('max_homes')}
                  className={`min-h-11 rounded-xl px-3 text-xs font-black transition-colors ${sizingMode === 'max_homes' ? 'bg-[#2EEB57] text-black' : 'text-white/55 hover:bg-white/5 hover:text-white'}`}
                >
                  Maximum homes
                </button>
                <button
                  type="button"
                  aria-pressed={sizingMode === 'route_count'}
                  onClick={() => switchSizingMode('route_count')}
                  className={`min-h-11 rounded-xl px-3 text-xs font-black transition-colors ${sizingMode === 'route_count' ? 'bg-[#2EEB57] text-black' : 'text-white/55 hover:bg-white/5 hover:text-white'}`}
                >
                  Number of routes
                </button>
              </div>
            </div>

            <label className="block space-y-1.5">
              <span className="text-xs font-bold text-white/65">
                {sizingMode === 'max_homes' ? 'Maximum homes per route' : 'How many routes?'}
              </span>
              <input
                type="number"
                min={sizingMode === 'route_count' ? 2 : 1}
                max={sizingMode === 'route_count' ? Math.max(totalHomes, 2) : Math.max(totalHomes - 1, 1)}
                value={requestedValue}
                onChange={(event) => {
                  setRequestedValue(event.target.value);
                  setSaveError('');
                }}
                className="h-12 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-base font-black text-white outline-none focus:border-[#39FF4A]"
              />
            </label>
          </section>

          {planResult.error ? (
            <div className="flex gap-2 rounded-2xl border border-amber-400/25 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{planResult.error}</span>
            </div>
          ) : plan && (
            <>
              <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#39FF4A]">Route plan</p>
                  <p className="mt-1 text-base font-black text-white">{routeCountCopy(plan)}</p>
                </div>
                <div className="flex flex-wrap gap-2 text-[10px] font-bold text-white/60">
                  <span className="inline-flex items-center gap-1 rounded-full border border-[#2EEB57]/20 bg-[#2EEB57]/10 px-2.5 py-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-[#39FF4A]" /> Nearby homes grouped
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-[#2EEB57]/20 bg-[#2EEB57]/10 px-2.5 py-1.5">
                    <RouteIcon className="h-3.5 w-3.5 text-[#39FF4A]" /> Each route optimized
                  </span>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                <section className="space-y-2">
                  <div className="flex items-center gap-2">
                    <MapIcon className="h-4 w-4 text-[#39FF4A]" />
                    <p className="text-xs font-black text-white">Geographic preview</p>
                  </div>
                  <SplitMapPreview routes={plan.routes} />
                  <p className="text-[10px] leading-relaxed text-white/40">
                    Colors show which homes stay together. Distance is an estimated between-home route before a rep or starting point is assigned.
                  </p>
                </section>

                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-black text-white">Route names</p>
                    <span className="text-[10px] text-white/35">Editable</span>
                  </div>
                  <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                    {plan.routes.map((child, index) => (
                      <label key={child.code} className="block rounded-xl border border-white/10 bg-white/[0.03] p-2.5">
                        <span className="flex items-center gap-2">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[10px] font-black text-black" style={{ backgroundColor: previewColor(index) }}>
                            {child.code}
                          </span>
                          <input
                            value={routeNames[index] || ''}
                            onChange={(event) => updateRouteName(index, event.target.value)}
                            className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/35 px-2.5 text-xs font-bold text-white outline-none focus:border-[#39FF4A]"
                            aria-label={`Route ${child.code} name`}
                          />
                        </span>
                        <span className="mt-1.5 block truncate pl-9 text-[10px] text-white/40">
                          {child.areaLabel || 'Optimized area'} · {child.houseCount} homes · {child.distanceMiles.toFixed(1)} estimated mi
                        </span>
                      </label>
                    ))}
                  </div>
                  {nameError && (
                    <p className="text-[10px] font-bold text-amber-300">{nameError}</p>
                  )}
                </section>
              </div>

              <div className="flex gap-2 rounded-2xl border border-white/10 bg-white/[0.025] p-3 text-[11px] leading-relaxed text-white/50">
                <Home className="mt-0.5 h-4 w-4 shrink-0 text-white/45" />
                <span>
                  {sourceWillBeArchived
                    ? 'The original route will be archived after every new route is created successfully. New routes start unassigned and unscheduled.'
                    : 'New routes start unassigned and unscheduled. This source is not a saved route, so it will remain available until you close it.'}
                </span>
              </div>
            </>
          )}

          {saveError && (
            <div className="flex gap-2 rounded-2xl border border-red-400/25 bg-red-500/10 p-3 text-xs leading-relaxed text-red-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{saveError}</span>
            </div>
          )}
        </div>

        <div className="flex gap-2 border-t border-white/10 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-5">
          <Button onClick={onClose} variant="outline" className="h-11 flex-1">Cancel</Button>
          <Button
            onClick={handleConfirm}
            disabled={isSaving || !plan || !namesComplete || !namesUnique}
            className="h-11 flex-1 bg-[#2EEB57] text-black hover:bg-[#39FF4A] disabled:bg-white/10 disabled:text-white/30"
          >
            {isSaving
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating routes</>
              : `Create ${plan?.routeCount || 0} Routes`}
          </Button>
        </div>
      </div>
    </div>
  );
}
