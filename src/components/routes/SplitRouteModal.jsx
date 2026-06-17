import React, { useMemo, useState } from 'react';
import { X, Scissors, CalendarDays, Users, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';
import { buildSplitPreview, buildSplitRouteRecords, getRouteStops, formatBatchDate } from './splitRouteUtils';

export default function SplitRouteModal({ route, teamMembers = [], managerId, onClose, onCreated }) {
  const totalStops = getRouteStops(route).length;
  const [stopsPerDay, setStopsPerDay] = useState(totalStops >= 25 ? 25 : Math.max(totalStops, 1));
  const [startDate, setStartDate] = useState('');
  const [assignmentMode, setAssignmentMode] = useState('all');
  const [allRepId, setAllRepId] = useState('');
  const [perBatchRepIds, setPerBatchRepIds] = useState([]);
  const [isSaving, setIsSaving] = useState(false);

  const preview = useMemo(() => buildSplitPreview({
    route,
    stopsPerDay,
    startDate,
    assignmentMode,
    allRepId,
    perBatchRepIds,
    teamMembers
  }), [route, stopsPerDay, startDate, assignmentMode, allRepId, perBatchRepIds, teamMembers]);

  const dateRange = preview.length && startDate
    ? `${formatBatchDate(preview[0].date)} – ${formatBatchDate(preview[preview.length - 1].date)}`
    : '';

  const updateBatchRep = (index, repId) => {
    setPerBatchRepIds((prev) => {
      const next = [...prev];
      next[index] = repId;
      return next;
    });
  };

  const handleConfirm = async () => {
    if (!Number.isInteger(Number(stopsPerDay)) || Number(stopsPerDay) < 1 || preview.length === 0) return;
    setIsSaving(true);
    const records = buildSplitRouteRecords({ route, batches: preview, managerId });
    await base44.entities.SavedRoute.bulkCreate(records);
    await onCreated?.(records.length);
    setIsSaving(false);
    onClose?.();
  };

  return (
    <div className="fixed inset-0 z-[5000] flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[92dvh] w-full max-w-2xl overflow-hidden rounded-t-2xl border border-white/10 bg-[#0A0A0A] text-white shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-black text-white">
              <Scissors className="h-4 w-4 text-[#39FF4A]" /> Split Route
            </h2>
            <p className="truncate text-xs text-white/45">{route?.name || 'Selected route'} • {totalStops} stops</p>
          </div>
          <button onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-white/10" aria-label="Close split route">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[calc(92dvh-140px)] overflow-y-auto px-4 py-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-xs font-bold uppercase text-white/60">Stops per day required</span>
              <input
                type="number"
                min="1"
                max={Math.max(totalStops, 1)}
                value={stopsPerDay}
                onChange={(e) => setStopsPerDay(e.target.value)}
                className="h-11 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-sm font-bold text-white outline-none focus:border-[#39FF4A]"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-bold uppercase text-white/60">Start date optional</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-11 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-sm font-bold text-white outline-none focus:border-[#39FF4A]"
              />
            </label>
          </div>

          <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-center gap-2 text-xs font-black uppercase text-white/70">
              <Users className="h-4 w-4 text-[#39FF4A]" /> Rep assignment optional
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setAssignmentMode('all')}
                className={`h-11 rounded-xl text-xs font-black ${assignmentMode === 'all' ? 'bg-[#2EEB57] text-black' : 'bg-white/5 text-white/60'}`}
              >
                Assign All
              </button>
              <button
                onClick={() => setAssignmentMode('each')}
                className={`h-11 rounded-xl text-xs font-black ${assignmentMode === 'each' ? 'bg-[#2EEB57] text-black' : 'bg-white/5 text-white/60'}`}
              >
                Per Batch
              </button>
            </div>

            {assignmentMode === 'all' ? (
              <select
                value={allRepId}
                onChange={(e) => setAllRepId(e.target.value)}
                className="h-11 w-full rounded-xl border border-white/10 bg-[#111] px-3 text-sm font-bold text-white outline-none"
              >
                <option value="">Unassigned</option>
                {teamMembers.map((rep) => <option key={rep.id} value={rep.id}>{rep.name}</option>)}
              </select>
            ) : (
              <div className="space-y-2">
                {preview.map((batch, index) => (
                  <div key={batch.batchNumber} className="grid grid-cols-[80px_1fr] items-center gap-2">
                    <span className="text-xs font-bold text-white/50">Batch {batch.batchNumber}</span>
                    <select
                      value={perBatchRepIds[index] || ''}
                      onChange={(e) => updateBatchRep(index, e.target.value)}
                      className="h-11 w-full rounded-xl border border-white/10 bg-[#111] px-3 text-sm font-bold text-white outline-none"
                    >
                      <option value="">Unassigned</option>
                      {teamMembers.map((rep) => <option key={rep.id} value={rep.id}>{rep.name}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-[#2EEB57]/20 bg-[#2EEB57]/5 p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-black uppercase text-[#39FF4A]">Batch preview</p>
                <p className="text-xs text-white/55">
                  {preview.length} batches • {totalStops} total stops{dateRange ? ` • ${dateRange}` : ''}
                </p>
              </div>
              {startDate && <CalendarDays className="h-5 w-5 text-[#39FF4A]" />}
            </div>
            <div className="max-h-52 space-y-1.5 overflow-y-auto pr-1">
              {preview.map((batch) => (
                <div key={batch.batchNumber} className="flex items-center justify-between gap-2 rounded-lg bg-black/30 px-3 py-2 text-xs">
                  <span className="font-bold text-white">Batch {batch.batchNumber}</span>
                  <span className="text-white/55">{batch.stops.length} stops</span>
                  <span className="text-white/55">{batch.date ? formatBatchDate(batch.date) : 'No date'}</span>
                  <span className="max-w-[90px] truncate text-[#39FF4A]">{batch.repName || 'Unassigned'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex gap-2 border-t border-white/10 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <Button onClick={onClose} variant="outline" className="h-11 flex-1">Cancel</Button>
          <Button onClick={handleConfirm} disabled={isSaving || preview.length === 0} className="h-11 flex-1 bg-[#2EEB57] text-black hover:bg-[#39FF4A]">
            {isSaving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving</> : `Create ${preview.length} Batches`}
          </Button>
        </div>
      </div>
    </div>
  );
}