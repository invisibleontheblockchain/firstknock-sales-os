import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Map, Pencil, Rocket, Save, Wand2, X } from 'lucide-react';
import { toast } from 'sonner';
import { generateCanvasZones } from '@/components/logic/canvasZones';

const PALETTE = ['#FFD700', '#ef4444', '#22c55e', '#3b82f6', '#ec4899', '#f97316', '#8b5cf6', '#06b6d4', '#eab308', '#14b8a6'];
const EMPTY_ARRAY = [];

function buildZones(count, teamMembers, existing = []) {
  return Array.from({ length: count }, (_, index) => {
    const prior = existing[index];
    const member = teamMembers.find((rep) => rep.id === prior?.assigned_to);
    return {
      zone_number: index + 1,
      name: `Zone ${index + 1}`,
      assigned_to: prior?.assigned_to || '',
      assigned_to_name: prior?.assigned_to_name || '',
      color: prior?.color || member?.color || PALETTE[index % PALETTE.length],
      geometry: prior?.geometry || [],
    };
  });
}

export default function CanvasBuilderSettings({
  drawnPolygon,
  hasDrawnArea,
  onDraw,
  onClearPolygon,
  onClose,
  user,
}) {
  const queryClient = useQueryClient();
  const [sessionName, setSessionName] = useState('');
  const [repCount, setRepCount] = useState(12);
  const [zones, setZones] = useState([]);
  const [saving, setSaving] = useState(false);

  const { data: teamMembers = EMPTY_ARRAY } = useQuery({
    queryKey: ['canvasTeamMembers', user?.id],
    queryFn: () => user?.id ? base44.entities.TeamMember.filter({ manager_id: user.id }, '-created_date', 500) : [],
    enabled: !!user?.id,
    staleTime: 1000 * 60 * 5,
  });

  const { data: savedSessionsRaw = EMPTY_ARRAY } = useQuery({
    queryKey: ['canvasSessions', user?.id],
    queryFn: () => user?.id ? base44.entities.CanvasSession.filter({ manager_id: user.id }, '-created_date', 20) : [],
    enabled: !!user?.id,
    staleTime: 1000 * 60 * 2,
  });

  const savedSessions = Array.isArray(savedSessionsRaw) ? savedSessionsRaw : (savedSessionsRaw?.items || []);

  const activeReps = useMemo(() => teamMembers.filter((rep) => rep.status !== 'inactive'), [teamMembers]);

  useEffect(() => {
    setZones((current) => {
      const merged = buildZones(repCount, activeReps, current);
      return generateCanvasZones(drawnPolygon, repCount, merged);
    });
  }, [repCount, activeReps, drawnPolygon]);

  const updateZoneRep = (zoneNumber, repId) => {
    const rep = activeReps.find((member) => member.id === repId);
    setZones((current) => current.map((zone) => zone.zone_number === zoneNumber ? {
      ...zone,
      assigned_to: rep?.id || '',
      assigned_to_name: rep?.name || '',
      color: rep?.color || zone.color,
    } : zone));
  };

  const loadSavedSession = (session) => {
    if (!session?.polygon?.length) return;
    localStorage.setItem('fk_drawnPolygon', JSON.stringify(session.polygon));
    localStorage.setItem('fk_canvasZones', JSON.stringify(generateCanvasZones(session.polygon, session.rep_count || 1, session.zones || [])));
    setSessionName(session.session_name || '');
    setRepCount(session.rep_count || 1);
    setZones(generateCanvasZones(session.polygon, session.rep_count || 1, buildZones(session.rep_count || 1, activeReps, session.zones || [])));
    toast.success('Saved territory loaded. Refreshing map...');
    window.location.reload();
  };

  const autoAssign = () => {
    if (activeReps.length === 0) {
      toast.error('Add active reps before auto-assigning zones.');
      return;
    }
    setZones((current) => current.map((zone, index) => {
      const rep = activeReps[index % activeReps.length];
      return {
        ...zone,
        assigned_to: rep.id,
        assigned_to_name: rep.name,
        color: rep.color || PALETTE[index % PALETTE.length],
      };
    }));
    toast.success(`Assigned ${currentRepLabel(repCount, activeReps.length)}.`);
  };

  const saveSession = async (status) => {
    if (!hasDrawnArea || !drawnPolygon?.length) {
      toast.error('Draw a territory before saving or deploying.');
      return;
    }
    setSaving(true);
    const zonesWithGeometry = generateCanvasZones(drawnPolygon, repCount, zones);
    setZones(zonesWithGeometry);
    localStorage.setItem('fk_canvasZones', JSON.stringify(zonesWithGeometry));
    window.dispatchEvent(new CustomEvent('fk-canvas-zones-updated', { detail: { zones: zonesWithGeometry } }));

    await base44.entities.CanvasSession.create({
      session_name: sessionName.trim() || `Canvas Session ${new Date().toLocaleDateString()}`,
      polygon: drawnPolygon,
      rep_count: repCount,
      zones: zonesWithGeometry,
      status,
      manager_id: user?.id,
    });
    queryClient.invalidateQueries({ queryKey: ['canvasSessions'] });
    setSaving(false);
    toast.success(status === 'deployed' ? 'Canvas zones deployed to the map.' : 'Territory saved.');
    if (status === 'deployed') onClose?.();
  };

  return (
    <div className="fixed inset-0 z-[2000]">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute top-0 right-0 bottom-0 w-full max-w-md overflow-hidden pt-[env(safe-area-inset-top)] bg-[#09090f]/95 border-l border-purple-500/20 shadow-2xl animate-in slide-in-from-right duration-300">
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-extrabold tracking-wide text-purple-300">
            <Map className="w-5 h-5" /> CANVAS BUILDER
          </h2>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors">
            <X className="w-5 h-5 text-gray-300" />
          </button>
        </div>

        <div className="overflow-y-auto h-[calc(100%-88px)] p-4 space-y-5 pb-28">
          <section className="rounded-2xl border border-purple-500/25 bg-purple-500/10 p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-purple-200 uppercase">1. Draw Territory</p>
                <p className="text-[11px] text-gray-400 mt-1">Canvas uses only a freehand shape. No sold data, filters, or paid pulls.</p>
              </div>
              <Button onClick={onDraw} size="sm" className="bg-purple-600 hover:bg-purple-500 text-white shrink-0">
                <Pencil className="w-4 h-4" /> {hasDrawnArea ? 'Redraw' : 'Draw'}
              </Button>
            </div>
            {hasDrawnArea ? (
              <div className="flex items-center justify-between rounded-xl bg-black/35 border border-purple-400/20 px-3 py-2">
                <span className="text-sm font-bold text-white">Territory ready — {zones.length} visual zones</span>
                <button onClick={onClearPolygon} className="text-xs font-bold text-red-300 hover:text-red-200">Clear</button>
              </div>
            ) : (
              <div className="rounded-xl bg-black/35 border border-white/10 px-3 py-3 text-center text-sm text-gray-400">Draw a polygon on the map to start.</div>
            )}
          </section>

          {savedSessions.length > 0 && (
            <section className="space-y-3">
              <label className="text-xs font-bold text-gray-400 uppercase">Load Saved Territory</label>
              <div className="grid gap-2">
                {savedSessions.slice(0, 3).map((session) => (
                  <button
                    key={session.id}
                    onClick={() => loadSavedSession(session)}
                    className="w-full rounded-xl border border-white/10 bg-[#12121a] px-3 py-2 text-left hover:border-purple-400/50 transition-colors"
                  >
                    <p className="text-sm font-bold text-white truncate">{session.session_name || 'Saved Canvas Territory'}</p>
                    <p className="text-[10px] text-gray-500">{session.rep_count || session.zones?.length || 0} zones</p>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="space-y-3">
            <label className="text-xs font-bold text-gray-400 uppercase">Session Name</label>
            <Input
              value={sessionName}
              onChange={(event) => setSessionName(event.target.value)}
              placeholder="Tuesday AM — Northside"
              className="bg-[#151520] border-white/10 text-white h-11"
            />
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-gray-400 uppercase">2. How many reps today?</label>
              <Badge className="bg-purple-500/20 text-purple-200 border-none">{zones.length} zones</Badge>
            </div>
            <Input
              type="number"
              min="1"
              max="500"
              value={repCount}
              onChange={(event) => setRepCount(Math.max(1, Math.min(500, Number(event.target.value) || 1)))}
              className="bg-[#151520] border-white/10 text-white h-12 text-lg font-bold"
            />
            <p className="text-[11px] text-gray-500">Zones are created instantly from the territory count — no routing or data filters needed.</p>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <label className="text-xs font-bold text-gray-400 uppercase">3. Assign Zones</label>
              <Button onClick={autoAssign} size="sm" className="bg-purple-600 hover:bg-purple-500 text-white">
                <Wand2 className="w-4 h-4" /> Auto-assign
              </Button>
            </div>
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {zones.map((zone) => (
                <div key={zone.zone_number} className="rounded-xl border border-white/10 bg-[#12121a] p-3 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center text-black text-xs font-extrabold shrink-0" style={{ background: zone.color }}>
                    {zone.zone_number}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-white">{zone.name}</p>
                    <p className="text-[10px] text-gray-500 truncate">{zone.assigned_to_name || 'Unassigned'}</p>
                  </div>
                  <Select value={zone.assigned_to || undefined} onValueChange={(value) => updateZoneRep(zone.zone_number, value)}>
                    <SelectTrigger className="w-32 bg-black/40 border-white/10 text-gray-200 h-9">
                      <SelectValue placeholder="Assign" />
                    </SelectTrigger>
                    <SelectContent className="bg-[#111] border-white/10 text-white">
                      {activeReps.map((rep) => (
                        <SelectItem key={rep.id} value={rep.id}>{rep.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="absolute bottom-0 left-0 right-0 p-4 bg-[#09090f] border-t border-white/10 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="flex gap-2">
            <Button disabled={saving} onClick={() => saveSession('draft')} className="h-12 px-4 bg-white/10 hover:bg-white/15 text-white border border-white/10">
              <Save className="w-4 h-4" /> Save
            </Button>
            <Button disabled={saving} onClick={() => saveSession('deployed')} className="flex-1 h-12 bg-purple-600 hover:bg-purple-500 text-white font-extrabold">
              <Rocket className="w-4 h-4" /> Deploy
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function currentRepLabel(zoneCount, repCount) {
  return `${zoneCount} zones across ${repCount} reps`;
}