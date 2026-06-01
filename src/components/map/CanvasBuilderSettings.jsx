import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Map, Pencil, Rocket, Save, Wand2, X, Lock, Unlock, Users, Clock, Home, MapPin } from 'lucide-react';
import { toast } from 'sonner';
import { generateCanvasZones, getCanvasCampaignSummary } from '@/components/logic/canvasZones';

const STORAGE_KEY = 'fk_canvasCampaignSprint1';
const ROSTER_KEY = 'fk_canvasRosterSprint1';
const DEMO_ROSTER = ['Marcus T.', 'Jordan K.', 'Aaliyah R.', 'Devon S.', 'Chris M.'];
const DEMO_POLYGON = [
  { lat: 34.5262, lng: -82.7107 },
  { lat: 34.5262, lng: -82.6866 },
  { lat: 34.5001, lng: -82.6866 },
  { lat: 34.5001, lng: -82.7107 },
];

const normalizeRoster = (value) => value.split('\n').map((name) => name.trim()).filter(Boolean);

const emptyAssignments = (repsPerZone) => Array.from({ length: Math.max(1, repsPerZone) }, () => '');

function buildInitialCampaign() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return {
    name: 'Tuesday AM — Anderson Northside',
    repCount: 8,
    shiftHours: 5,
    doorsPerHour: 20,
    repsPerZone: 1,
    densityMode: 'auto',
    customDoorsPerSqMi: 150,
    zones: [],
    locked: false,
    deployedAt: null,
  };
}

export default function CanvasBuilderSettings({ drawnPolygon, hasDrawnArea, onDraw, onClearPolygon, onClose }) {
  const [campaign, setCampaign] = useState(buildInitialCampaign);
  const [rosterText, setRosterText] = useState(() => {
    try { return localStorage.getItem(ROSTER_KEY) || DEMO_ROSTER.join('\n'); } catch { return DEMO_ROSTER.join('\n'); }
  });
  const [selectedZoneNumber, setSelectedZoneNumber] = useState(null);
  const [saving, setSaving] = useState(false);

  const roster = useMemo(() => normalizeRoster(rosterText), [rosterText]);
  const effectivePolygon = hasDrawnArea && drawnPolygon?.length > 2 ? drawnPolygon : DEMO_POLYGON;
  const summary = useMemo(() => getCanvasCampaignSummary({ polygon: effectivePolygon, ...campaign }), [effectivePolygon, campaign]);

  const zones = useMemo(() => generateCanvasZones(effectivePolygon, campaign, campaign.zones || []), [effectivePolygon, campaign]);
  const selectedZone = zones.find((zone) => zone.zone_number === selectedZoneNumber) || zones[0] || null;
  const assignedCount = zones.filter((zone) => zone.assignments?.filter(Boolean).length || zone.assigned_to_name).length;
  const canDeploy = assignedCount > 0;

  useEffect(() => {
    localStorage.setItem(ROSTER_KEY, rosterText);
  }, [rosterText]);

  useEffect(() => {
    localStorage.setItem('fk_canvasZones', JSON.stringify(zones));
    window.dispatchEvent(new CustomEvent('fk-canvas-zones-updated', { detail: { zones } }));
  }, [zones]);

  const updateCampaign = (patch) => {
    if (campaign.locked) return toast.info('Campaign is locked. Tap Edit Campaign to make changes.');
    setCampaign((current) => ({ ...current, ...patch }));
  };

  const updateZone = (zoneNumber, patch) => {
    if (campaign.locked) return toast.info('Campaign is locked. Tap Edit Campaign to make changes.');
    setCampaign((current) => {
      const existingZones = zones.map((zone) => zone.zone_number === zoneNumber ? { ...zone, ...patch } : zone);
      return { ...current, zones: existingZones };
    });
  };

  const autoAssign = () => {
    if (!roster.length) return toast.error('Add rep names before auto-assigning.');
    updateCampaign({
      zones: zones.map((zone, index) => ({
        ...zone,
        assignments: emptyAssignments(campaign.repsPerZone).map((_, slot) => roster[(index * campaign.repsPerZone + slot) % roster.length]),
        assigned_to_name: emptyAssignments(campaign.repsPerZone).map((_, slot) => roster[(index * campaign.repsPerZone + slot) % roster.length]).join(' + '),
      }))
    });
    toast.success('Roster distributed across zones.');
  };

  const saveCampaign = (lock = false) => {
    setSaving(true);
    const payload = {
      ...campaign,
      polygon: effectivePolygon,
      zones,
      roster,
      locked: lock ? true : campaign.locked,
      deployedAt: lock ? new Date().toISOString() : campaign.deployedAt,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    localStorage.setItem('fk_drawnPolygon', JSON.stringify(effectivePolygon));
    localStorage.setItem('fk_canvasZones', JSON.stringify(zones));
    setCampaign(payload);
    setSaving(false);
    window.dispatchEvent(new CustomEvent('fk-canvas-zones-updated', { detail: { zones } }));
    toast.success(lock ? 'Campaign deployed locally.' : 'Campaign saved locally.');
  };

  const loadCampaign = () => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return toast.info('No saved Canvas campaign yet.');
      const parsed = JSON.parse(saved);
      setCampaign(parsed);
      setRosterText((parsed.roster || DEMO_ROSTER).join('\n'));
      if (parsed.polygon) localStorage.setItem('fk_drawnPolygon', JSON.stringify(parsed.polygon));
      if (parsed.zones) localStorage.setItem('fk_canvasZones', JSON.stringify(parsed.zones));
      window.dispatchEvent(new CustomEvent('fk-canvas-zones-updated', { detail: { zones: parsed.zones || [] } }));
      toast.success('Saved campaign loaded.');
    } catch {
      toast.error('Could not load saved campaign.');
    }
  };

  const densityOptions = ['auto', 'urban', 'suburban', 'rural', 'custom'];

  return (
    <div className="fixed inset-0 z-[2000] pointer-events-none lg:flex">
      <div className="hidden lg:block pointer-events-auto w-[390px] h-full bg-[#09090f]/95 border-r border-purple-500/20 shadow-2xl pt-[env(safe-area-inset-top)]">
        <BuilderContent {...{ campaign, setCampaign, updateCampaign, rosterText, setRosterText, roster, zones, selectedZone, setSelectedZoneNumber, updateZone, autoAssign, saveCampaign, loadCampaign, onDraw, onClearPolygon, onClose, summary, densityOptions, saving, canDeploy, hasDrawnArea }} />
      </div>

      <div className="lg:hidden pointer-events-auto absolute left-0 right-0 bottom-0 max-h-[78vh] rounded-t-3xl bg-[#09090f]/98 border-t border-purple-500/25 shadow-2xl overflow-hidden pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-white/20" />
        <BuilderContent {...{ campaign, setCampaign, updateCampaign, rosterText, setRosterText, roster, zones, selectedZone, setSelectedZoneNumber, updateZone, autoAssign, saveCampaign, loadCampaign, onDraw, onClearPolygon, onClose, summary, densityOptions, saving, canDeploy, hasDrawnArea }} compact />
      </div>
    </div>
  );
}

function BuilderContent({ campaign, setCampaign, updateCampaign, rosterText, setRosterText, roster, zones, selectedZone, setSelectedZoneNumber, updateZone, autoAssign, saveCampaign, loadCampaign, onDraw, onClearPolygon, onClose, summary, densityOptions, saving, canDeploy, hasDrawnArea, compact = false }) {
  return (
    <div className="h-full flex flex-col text-white">
      <div className="p-4 border-b border-white/10 flex items-center justify-between shrink-0">
        <h2 className="flex items-center gap-2 font-extrabold tracking-wide text-purple-300">
          <Map className="w-5 h-5" /> CANVAS MODE
        </h2>
        <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors"><X className="w-5 h-5 text-gray-300" /></button>
      </div>

      <div className="overflow-y-auto p-4 space-y-4 pb-32">
        {campaign.locked && (
          <div className="rounded-2xl border border-green-500/30 bg-green-500/10 p-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-green-300">Campaign deployed</p>
              <p className="text-[11px] text-green-100/70">Sprint 1 deploy is saved locally for demo/field handoff.</p>
            </div>
            <Button onClick={() => setCampaign((current) => ({ ...current, locked: false }))} size="sm" className="bg-white/10 text-white border border-white/10"><Unlock className="w-4 h-4" /> Edit</Button>
          </div>
        )}

        <section className="space-y-3">
          <Input value={campaign.name} onChange={(e) => updateCampaign({ name: e.target.value })} className="bg-[#151520] border-white/10 text-white h-11 font-bold" />
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={onDraw} className="h-10 bg-purple-600 hover:bg-purple-500 text-white"><Pencil className="w-4 h-4" /> {hasDrawnArea ? 'Redraw' : 'Draw'}</Button>
            <Button onClick={loadCampaign} className="h-10 bg-white/10 hover:bg-white/15 text-white border border-white/10"><Save className="w-4 h-4" /> Load</Button>
          </div>
          <div className="rounded-xl bg-black/35 border border-white/10 p-3 flex items-center justify-between gap-2">
            <span className="text-xs text-gray-300">{hasDrawnArea ? 'Drawn territory active' : 'Using pre-loaded Anderson demo territory'}</span>
            {hasDrawnArea && <button onClick={onClearPolygon} className="text-xs font-bold text-red-300">Clear</button>}
          </div>
        </section>

        <section className="rounded-2xl border border-purple-500/25 bg-purple-500/10 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Rep count" value={campaign.repCount} min={1} max={500} onChange={(v) => updateCampaign({ repCount: v })} />
            <NumberField label="Shift hours" value={campaign.shiftHours} min={1} max={16} onChange={(v) => updateCampaign({ shiftHours: v })} />
            <NumberField label="Doors/hour" value={campaign.doorsPerHour} min={1} max={60} onChange={(v) => updateCampaign({ doorsPerHour: v })} />
            <div>
              <label className="text-[10px] font-bold text-gray-400 uppercase">Reps / zone</label>
              <div className="grid grid-cols-2 gap-1 mt-1 rounded-xl bg-black/30 p-1 border border-white/10">
                {[1, 2].map((value) => <button key={value} onClick={() => updateCampaign({ repsPerZone: value })} className={`h-9 rounded-lg text-xs font-black ${campaign.repsPerZone === value ? 'bg-purple-500 text-white' : 'text-gray-400'}`}>{value}</button>)}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Metric icon={Home} label="Doors / rep" value={`~${summary.doorsPerRep}`} />
            <Metric icon={Users} label="Zones" value={summary.zoneCount} />
            <Metric icon={MapPin} label="Area" value={`${summary.areaSqMi.toFixed(2)} mi²`} />
            <Metric icon={Clock} label="Doors / zone" value={`~${summary.targetDoorsPerZone}`} />
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold text-gray-400 uppercase">Density</label>
            <Badge className="bg-purple-500/20 text-purple-200 border-none">{summary.density.label} · {summary.density.doorsPerSqMi}/mi²</Badge>
          </div>
          <div className="grid grid-cols-5 gap-1">
            {densityOptions.map((option) => <button key={option} onClick={() => updateCampaign({ densityMode: option })} className={`py-2 rounded-lg text-[10px] font-black capitalize border ${campaign.densityMode === option ? 'bg-purple-500 text-white border-purple-300' : 'bg-[#151520] text-gray-400 border-white/10'}`}>{option}</button>)}
          </div>
          {campaign.densityMode === 'custom' && <NumberField label="Custom doors / sq mi" value={campaign.customDoorsPerSqMi} min={1} max={2000} onChange={(v) => updateCampaign({ customDoorsPerSqMi: v })} />}
          <p className="text-[11px] text-gray-500">Each zone targets ~{summary.targetDoorsPerZone} doors. Dense areas create smaller cells; sparse areas create larger cells.</p>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs font-bold text-gray-400 uppercase">Roster</label>
            <Button onClick={autoAssign} size="sm" className="bg-purple-600 hover:bg-purple-500 text-white"><Wand2 className="w-4 h-4" /> Auto-assign</Button>
          </div>
          <textarea value={rosterText} onChange={(e) => setRosterText(e.target.value)} className="w-full min-h-[92px] rounded-xl bg-[#151520] border border-white/10 text-sm text-white p-3 outline-none focus:border-purple-400" placeholder="One rep per line" />
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold text-gray-400 uppercase">Zones</label>
            <Badge className="bg-white/10 text-gray-200 border-none">{zones.length} total</Badge>
          </div>
          <div className={`grid gap-2 ${compact ? 'max-h-52' : 'max-h-64'} overflow-y-auto pr-1`}>
            {zones.map((zone) => {
              const assigned = zone.assignments?.filter(Boolean).join(' + ') || zone.assigned_to_name;
              return (
                <button key={zone.zone_number} onClick={() => setSelectedZoneNumber(zone.zone_number)} className={`rounded-xl border p-3 text-left flex items-center gap-3 ${selectedZone?.zone_number === zone.zone_number ? 'border-purple-400 bg-purple-500/15' : 'border-white/10 bg-[#12121a]'}`}>
                  <span className="w-9 h-9 rounded-xl flex items-center justify-center text-black text-xs font-extrabold shrink-0" style={{ background: zone.color }}>{zone.zone_number}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-bold text-white">Zone {zone.zone_number} · ~{zone.estimated_doors} doors</span>
                    <span className={`block text-[10px] truncate ${assigned ? 'text-gray-400' : 'text-red-300'}`}>{assigned || 'Unassigned'}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {selectedZone && <ZoneDetail zone={selectedZone} roster={roster} repsPerZone={campaign.repsPerZone} onChange={(patch) => updateZone(selectedZone.zone_number, patch)} />}
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-4 bg-[#09090f] border-t border-white/10 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="flex gap-2">
          <Button disabled={saving} onClick={() => saveCampaign(false)} className="h-12 px-4 bg-white/10 hover:bg-white/15 text-white border border-white/10"><Save className="w-4 h-4" /> Save</Button>
          <Button disabled={saving || !canDeploy} onClick={() => saveCampaign(true)} className="flex-1 h-12 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-500 text-white font-extrabold"><Rocket className="w-4 h-4" /> Deploy Campaign</Button>
          {campaign.locked && <Button onClick={() => setCampaign((current) => ({ ...current, locked: false }))} className="h-12 px-3 bg-green-600/20 text-green-300 border border-green-500/30"><Lock className="w-4 h-4" /></Button>}
        </div>
      </div>
    </div>
  );
}

function NumberField({ label, value, min, max, onChange }) {
  return <div><label className="text-[10px] font-bold text-gray-400 uppercase">{label}</label><Input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))} className="mt-1 bg-[#151520] border-white/10 text-white h-10 font-bold" /></div>;
}

function Metric({ icon: Icon, label, value }) {
  return <div className="rounded-xl bg-black/30 border border-white/10 p-3"><Icon className="w-4 h-4 text-purple-300 mb-1" /><p className="text-[10px] text-gray-500 uppercase font-bold">{label}</p><p className="text-sm font-black text-white">{value}</p></div>;
}

function ZoneDetail({ zone, roster, repsPerZone, onChange }) {
  const assignments = zone.assignments?.length ? zone.assignments : emptyAssignments(repsPerZone);
  const updateAssignment = (index, value) => {
    const next = [...assignments];
    next[index] = value;
    onChange({ assignments: next, assigned_to_name: next.filter(Boolean).join(' + ') });
  };

  return (
    <section className="rounded-2xl border border-white/10 bg-[#12121a] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div><p className="text-sm font-black text-white">Zone {zone.zone_number}</p><p className="text-[11px] text-gray-500">~{zone.estimated_doors} doors · {zone.area_sq_mi} mi²</p></div>
        <span className="w-9 h-9 rounded-xl" style={{ background: zone.color }} />
      </div>
      <p className="text-[11px] text-gray-400">Drop point: {zone.drop_point ? `${zone.drop_point.lat.toFixed(5)}, ${zone.drop_point.lng.toFixed(5)}` : 'NW corner'}</p>
      {assignments.map((value, index) => (
        <select key={index} value={value} onChange={(e) => updateAssignment(index, e.target.value)} className="w-full h-10 rounded-xl bg-black/40 border border-white/10 text-sm text-white px-3">
          <option value="">Assign rep {index + 1}</option>
          {roster.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      ))}
      <select value={zone.status || 'unworked'} onChange={(e) => onChange({ status: e.target.value })} className="w-full h-10 rounded-xl bg-black/40 border border-white/10 text-sm text-white px-3">
        <option value="unworked">Unworked</option>
        <option value="in_progress">In Progress</option>
        <option value="complete">Complete</option>
      </select>
      <textarea value={zone.notes || ''} onChange={(e) => onChange({ notes: e.target.value })} className="w-full min-h-[70px] rounded-xl bg-black/40 border border-white/10 text-sm text-white p-3" placeholder="Notes: gated, apartment, skip area..." />
    </section>
  );
}