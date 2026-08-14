import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Home,
  Loader2,
  Map as MapIcon,
  Maximize2,
  Route as RouteIcon,
  Scissors,
  Shuffle,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';
import SplitRoutePreviewMap, { previewColor } from './SplitRoutePreviewMap';
import {
  buildOptimizedSplitPlan,
  buildSplitRouteRecords,
  getRouteStops,
  routeMembershipMatches,
  splitRouteCreationMatchesPlan,
} from './splitRouteUtils';

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
  if (Array.isArray(response?.data?.items)) return response.data.items;
  return [];
}

function entityRecord(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  if (response.data && typeof response.data === 'object' && !Array.isArray(response.data)) return response.data;
  return response;
}

function createSplitOperationId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // A timestamp fallback is sufficient to correlate this one client operation.
  }
  return `split_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function mergeCreatedRoutes(...groups) {
  const byId = new Map();
  groups.flat().forEach((created) => {
    const id = String(created?.id || '').trim();
    if (id && !byId.has(id)) byId.set(id, created);
  });
  return [...byId.values()];
}

function sourceArchivedForOperation(source, operationId, createdRoutes) {
  if (String(source?.status || '').toUpperCase() !== 'ARCHIVED') return false;
  const replacement = source?.metadata?.split_replacement;
  if (replacement?.operation_id !== operationId) return false;
  const expectedIds = createdRoutes.map((created) => String(created?.id || '')).filter(Boolean).sort();
  const persistedIds = (replacement?.child_route_ids || []).map(String).filter(Boolean).sort();
  return expectedIds.length > 0
    && expectedIds.length === persistedIds.length
    && expectedIds.every((id, index) => id === persistedIds[index]);
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
  // The plan rebuild + map refit is heavy, so typing updates a local field and
  // only commits after a short pause. Recomputing on every keystroke is what
  // made this input feel laggy and made the preview map flicker.
  const [valueDraft, setValueDraft] = useState(() => String(defaultMaximum(totalHomes)));
  const [variant, setVariant] = useState(0);
  const [isPreviewExpanded, setIsPreviewExpanded] = useState(false);
  const [routeNames, setRouteNames] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (valueDraft === String(requestedValue)) return undefined;
    const timeoutId = setTimeout(() => setRequestedValue(valueDraft), 250);
    return () => clearTimeout(timeoutId);
  }, [valueDraft, requestedValue]);

  const planResult = useMemo(() => {
    try {
      return {
        plan: buildOptimizedSplitPlan({ route, sizingMode, value: requestedValue, variant }),
        error: '',
      };
    } catch (error) {
      return { plan: null, error: error?.message || 'This route could not be divided.' };
    }
  }, [route, sizingMode, requestedValue, variant]);
  const plan = planResult.plan;
  const planSignature = plan
    ? `${route?.id || route?.name || 'route'}:${sizingMode}:${requestedValue}:${variant}:${plan.routeCount}`
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
    const nextValue = plan
      ? (nextMode === 'route_count'
        ? plan.routeCount
        : Math.min(Math.ceil(plan.totalHomes / plan.routeCount), plan.totalHomes - 1))
      : (nextMode === 'route_count' ? 2 : defaultMaximum(totalHomes));
    setRequestedValue(nextValue);
    setValueDraft(String(nextValue));
    setSizingMode(nextMode);
    setSaveError('');
  };

  const updateRouteName = (index, value) => {
    setRouteNames((current) => current.map((name, nameIndex) => (
      nameIndex === index ? value : name
    )));
  };

  const rollbackCreatedRoutes = async (createdRoutes) => {
    const ids = [...new Set(createdRoutes.map((created) => created?.id).filter(Boolean))];
    if (!ids.length || ids.length !== createdRoutes.length) return false;
    const results = await Promise.allSettled(ids.map((id) => base44.entities.SavedRoute.delete(id)));
    return results.every((result) => (
      result.status === 'fulfilled' && result.value?.success === true
    ));
  };

  const findCreatedRoutesForOperation = async (operationId) => {
    if (!route?.id || !operationId) return [];
    const found = [];
    const pageSize = 200;
    let previousPageSignature = '';

    for (let page = 0; page < 100; page += 1) {
      const response = await base44.entities.SavedRoute.filter(
        { parent_route_id: route.id },
        '-created_date',
        pageSize,
        page * pageSize,
      );
      const rows = entityRows(response);
      const pageSignature = rows.map((created) => created?.id || '').join('|');
      if (rows.length === pageSize && pageSignature && pageSignature === previousPageSignature) {
        throw new Error('Saved-route pagination repeated while verifying the split.');
      }
      previousPageSignature = pageSignature;
      found.push(...rows.filter((created) => (
        created?.metadata?.split_source?.operation_id === operationId
      )));
      if (rows.length < pageSize) break;
    }

    return mergeCreatedRoutes(found);
  };

  const handleConfirm = async () => {
    if (!plan || !namesComplete || !namesUnique || isSaving) return;
    setIsSaving(true);
    setSaveError('');
    const createdAt = new Date().toISOString();
    const operationId = createSplitOperationId();
    const records = buildSplitRouteRecords({
      route,
      plan,
      managerId,
      routeNames: trimmedNames,
      createdAt,
      operationId,
    });
    const plannedSourceHashes = records.flatMap((record) => record.property_hashes || []);
    let createdRoutes = [];

    try {
      let createError = null;
      try {
        const createdResponse = await base44.entities.SavedRoute.bulkCreate(records);
        createdRoutes = entityRows(createdResponse);
      } catch (error) {
        createError = error;
      }

      if (!splitRouteCreationMatchesPlan(records, createdRoutes) && sourceWillBeArchived) {
        try {
          const discoveredRoutes = await findCreatedRoutesForOperation(operationId);
          createdRoutes = mergeCreatedRoutes(createdRoutes, discoveredRoutes);
        } catch (verificationError) {
          console.error('[SplitRouteModal] Could not reconcile persisted child routes', verificationError);
        }
      }

      if (!splitRouteCreationMatchesPlan(records, createdRoutes)) {
        const rolledBack = await rollbackCreatedRoutes(createdRoutes);
        throw new Error(rolledBack
          ? 'FirstKnock could not verify every new route, so the returned routes were removed. No source route was archived.'
          : 'FirstKnock could not verify every new route. No source route was archived; refresh Routes and review any new routes before retrying.',
        createError ? { cause: createError } : undefined);
      }

      if (createError) {
        console.warn('[SplitRouteModal] Recovered a completed child write after its response was lost', createError);
      }

      let sourceArchived = false;

      if (sourceWillBeArchived) {
        let currentSource = null;
        try {
          currentSource = entityRecord(await base44.entities.SavedRoute.get(route.id));
        } catch (sourceReadError) {
          const rolledBack = await rollbackCreatedRoutes(createdRoutes);
          throw new Error(rolledBack
            ? 'The original route could not be checked safely, so the new routes were removed and the original stayed active.'
            : 'The original route could not be checked safely. It was not archived; refresh Routes and review the new routes before retrying.',
          { cause: sourceReadError });
        }

        const currentStatus = String(currentSource?.status || 'PENDING').toUpperCase();
        if (
          !routeMembershipMatches(plannedSourceHashes, currentSource?.property_hashes)
          || ['COMPLETED', 'ARCHIVED'].includes(currentStatus)
        ) {
          const rolledBack = await rollbackCreatedRoutes(createdRoutes);
          throw new Error(rolledBack
            ? 'The original route changed while this planner was open, so the new routes were removed. Refresh the route and try again.'
            : 'The original route changed while this planner was open. It was not archived; refresh Routes and review the new routes before retrying.');
        }

        if (!currentSource?.updated_date) {
          const rolledBack = await rollbackCreatedRoutes(createdRoutes);
          throw new Error(rolledBack
            ? 'The original route did not include a safe version marker, so the new routes were removed. Refresh the route and try again.'
            : 'The original route could not be version-checked safely. It was not archived; refresh Routes and review the new routes before retrying.');
        }

        const archivedAt = new Date().toISOString();
        const splitReplacement = {
          operation_id: operationId,
          child_route_ids: createdRoutes.map((created) => created.id),
          child_route_names: [...trimmedNames],
          archived_at: archivedAt,
          previous_status: currentSource.status || 'PENDING',
          previous_assigned_to: currentSource.assigned_to || null,
          previous_assigned_to_name: currentSource.assigned_to_name || null,
          sizing_mode: plan.sizingMode,
          requested_value: plan.requestedValue,
        };

        const archiveQuery = {
          id: route.id,
          status: currentSource.status || 'PENDING',
          updated_date: currentSource.updated_date,
          ...(currentSource.manager_id ? { manager_id: currentSource.manager_id } : {}),
        };
        const archiveUpdate = {
          status: 'ARCHIVED',
          assigned_to: null,
          assigned_to_name: null,
          metadata: {
            ...(currentSource.metadata || {}),
            split_replacement: splitReplacement,
          },
        };

        let archiveMutation = null;
        let archiveError = null;
        try {
          archiveMutation = entityRecord(await base44.entities.SavedRoute.updateMany(
            archiveQuery,
            { $set: archiveUpdate },
          ));
        } catch (error) {
          archiveError = error;
        }

        const archiveWriteConfirmed = archiveMutation?.success === true
          && Number(archiveMutation?.updated) === 1
          && archiveMutation?.has_more !== true;
        const archiveCasConflict = archiveMutation?.success === true
          && Number(archiveMutation?.updated) === 0
          && archiveMutation?.has_more !== true;

        let confirmedSource = null;
        let archiveReadError = null;
        try {
          confirmedSource = entityRecord(await base44.entities.SavedRoute.get(route.id));
        } catch (error) {
          archiveReadError = error;
        }

        const readbackConfirmed = sourceArchivedForOperation(confirmedSource, operationId, createdRoutes);
        if (archiveWriteConfirmed || readbackConfirmed) {
          if (confirmedSource && !routeMembershipMatches(plannedSourceHashes, confirmedSource.property_hashes)) {
            console.warn('[SplitRouteModal] Source membership changed after its atomic archive', {
              routeId: route.id,
              operationId,
            });
          }

          sourceArchived = true;
        } else if (archiveCasConflict) {
          const rolledBack = await rollbackCreatedRoutes(createdRoutes);
          throw new Error(rolledBack
            ? 'The original route changed before the split could finish, so the new routes were removed. Refresh the route and try again.'
            : 'The original route changed before the split could finish. It was not archived; refresh Routes and review the new routes before retrying.');
        } else {
          throw new Error(
            'FirstKnock could not confirm the original route’s archive state, so the verified new routes were kept. Refresh Routes and review before dispatching.',
            { cause: archiveError || archiveReadError },
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
      setSaveError(error?.message || 'FirstKnock could not finish this split. Refresh Routes and review before retrying.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[5000] flex items-end justify-center bg-black/75 p-0 sm:items-center sm:p-4"
      onClick={() => { if (!isSaving) onClose?.(); }}
    >
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
          <button
            onClick={onClose}
            disabled={isSaving}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Close route planner"
          >
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
                  disabled={isSaving}
                  aria-pressed={sizingMode === 'max_homes'}
                  onClick={() => switchSizingMode('max_homes')}
                  className={`min-h-11 rounded-xl px-3 text-xs font-black transition-colors ${sizingMode === 'max_homes' ? 'bg-[#2EEB57] text-black' : 'text-white/55 hover:bg-white/5 hover:text-white'}`}
                >
                  Maximum homes
                </button>
                <button
                  type="button"
                  disabled={isSaving}
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
                value={valueDraft}
                disabled={isSaving}
                onChange={(event) => {
                  setValueDraft(event.target.value);
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
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <MapIcon className="h-4 w-4 text-[#39FF4A]" />
                      <p className="text-xs font-black text-white">Geographic preview</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={isSaving}
                        onClick={() => setVariant((current) => current + 1)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 text-[10px] font-black text-white/75 hover:bg-white/10 hover:text-white disabled:opacity-30"
                      >
                        <Shuffle className="h-3.5 w-3.5 text-[#39FF4A]" /> New areas
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsPreviewExpanded(true)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 text-[10px] font-black text-white/75 hover:bg-white/10 hover:text-white"
                      >
                        <Maximize2 className="h-3.5 w-3.5 text-[#39FF4A]" /> Enlarge
                      </button>
                    </div>
                  </div>
                  <div className="h-56 overflow-hidden rounded-2xl border border-white/10 bg-[#111] sm:h-64">
                    <SplitRoutePreviewMap routes={plan.routes} />
                  </div>
                  <p className="text-[10px] leading-relaxed text-white/40">
                    Colors show which homes stay together. Zoom in to inspect, or tap New areas to regroup the homes. Distance is an estimated between-home route before a rep or starting point is assigned.
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
                            disabled={isSaving}
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
          <Button onClick={onClose} disabled={isSaving} variant="outline" className="h-11 flex-1">Cancel</Button>
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

        {isPreviewExpanded && plan && (
          <div className="fixed inset-0 z-[5100] flex flex-col bg-[#050505]">
            <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-black text-white">Geographic preview</p>
                <p className="truncate text-[11px] text-white/45">{routeCountCopy(plan)}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => setVariant((current) => current + 1)}
                  className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 text-xs font-black text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-30"
                >
                  <Shuffle className="h-4 w-4 text-[#39FF4A]" /> New areas
                </button>
                <button
                  type="button"
                  onClick={() => setIsPreviewExpanded(false)}
                  className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-white/10"
                  aria-label="Close enlarged preview"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="flex-1">
              <SplitRoutePreviewMap routes={plan.routes} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}