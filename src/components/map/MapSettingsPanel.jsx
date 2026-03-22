import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { X, Sun, Moon, Globe, Mountain, Eye, EyeOff, Circle, Square, Diamond, Layers, Droplets, RotateCcw, Save, Calendar, MapPin, Zap, GitBranch, Type } from 'lucide-react';

/* ── constants ── */
const REP_COLOR_OPTIONS = ['#FFD700','#ef4444','#22c55e','#3b82f6','#ec4899','#f97316','#8b5cf6','#06b6d4','#eab308','#14b8a6'];

const COLOR_SCHEMES = [
  { id: 'default', label: 'Default', colors: { ELIGIBLE:'#404040', SOLD:'#00F5A0', HARD_NO:'#FF6B6B', CALLBACK:'#FFD93D', NO_ANSWER:'#404040' } },
  { id: 'neon', label: 'Neon', colors: { ELIGIBLE:'#00fff7', SOLD:'#39ff14', HARD_NO:'#ff073a', CALLBACK:'#ffed00', NO_ANSWER:'#00fff7' } },
  { id: 'pastel', label: 'Pastel', colors: { ELIGIBLE:'#a8b8c8', SOLD:'#77dd77', HARD_NO:'#b39ddb', CALLBACK:'#fff176', NO_ANSWER:'#a8b8c8' } },
  { id: 'heatmap', label: 'Heat', colors: { ELIGIBLE:'#1e3a5f', SOLD:'#ff4500', HARD_NO:'#8b0000', CALLBACK:'#ff8c00', NO_ANSWER:'#1e3a5f' } },
  { id: 'monochrome', label: 'Mono', colors: { ELIGIBLE:'#555', SOLD:'#fff', HARD_NO:'#888', CALLBACK:'#bbb', NO_ANSWER:'#555' } },
];

const LINE_STYLES = [
  { id: 'solid', label: 'Solid', da: null },
  { id: 'dashed', label: 'Dashed', da: '8,6' },
  { id: 'dotted', label: 'Dotted', da: '2,4' },
  { id: 'dashdot', label: 'Dash-Dot', da: '10,4,2,4' },
];

const STATUS_FILTERS = [
  { id: 'all', label: 'All', color: '#E5E5E5' },
  { id: 'eligible', label: 'Not Visited', color: '#404040' },
  { id: 'sold', label: 'Sold', color: '#00F5A0' },
  { id: 'rejected', label: 'Undecided', color: '#FF6B6B' },
];

const MAP_STYLES = [
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'satellite', label: 'Satellite', icon: Globe },
  { id: 'hybrid', label: 'Hybrid', icon: Mountain },
];

/* ── sub-component: section header ── */
function SectionLabel({ children }) {
  return <h4 className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mb-3 mt-1">{children}</h4>;
}

/* ── main panel ── */
export default function MapSettingsPanel({
  mapTheme, setMapTheme,
  teamMembers, repColors, onUpdateRepColor,
  onClose,
  quickFilter, setQuickFilter,
  showRouteDetails, setShowRouteDetails,
  showAllProperties, setShowAllProperties,
  navigationApp, setNavigationApp,
  pinSize = 5, setPinSize,
  showRouteLines = false, setShowRouteLines,
  mapSettings, setMapSettings,
  soldDateFilter, setSoldDateFilter,
  highlightRecentlySold, setHighlightRecentlySold,
  onRequestGenerate,
  showZipOverlay = false, setShowZipOverlay,
}) {
  // Local buffered state
  const [local, setLocal] = useState({
    mapSettings: mapSettings || {},
    pinSize, showRouteLines, showRouteDetails, showAllProperties,
    mapTheme, navigationApp, quickFilter,
    soldDateFilter, highlightRecentlySold, showZipOverlay,
  });

  const upd = (key, val) => setLocal(p => ({ ...p, [key]: val }));
  const updMs = (key, val) => setLocal(p => ({ ...p, mapSettings: { ...p.mapSettings, [key]: val } }));

  const ms = local.mapSettings;

  // Live filter updates
  const setLiveQuickFilter = (v) => { upd('quickFilter', v); setQuickFilter?.(v); };
  const setLiveSoldDateFilter = (v) => {
    upd('soldDateFilter', v);
    setSoldDateFilter?.(v);
    if (v !== null && v !== 'all') {
      const confirmed = window.confirm(`Update filtering to "Sold in last ${v} months"?`);
      if (confirmed && onRequestGenerate) onRequestGenerate();
    }
  };
  const setLiveShowAll = (v) => { upd('showAllProperties', v); setShowAllProperties?.(v); };
  const setLiveHighlight = (v) => { upd('highlightRecentlySold', v); setHighlightRecentlySold?.(v); };
  const setLiveZip = (v) => { upd('showZipOverlay', v); setShowZipOverlay?.(v); };

  const handleSave = () => {
    setMapSettings?.(local.mapSettings);
    setPinSize?.(local.pinSize);
    setShowRouteLines?.(local.showRouteLines);
    setShowRouteDetails?.(local.showRouteDetails);
    setShowAllProperties?.(local.showAllProperties);
    setMapTheme?.(local.mapTheme);
    setNavigationApp?.(local.navigationApp);
    setHighlightRecentlySold?.(local.highlightRecentlySold);
    setShowZipOverlay?.(local.showZipOverlay);
    onClose();
  };

  const handleReset = () => {
    setLocal({
      mapSettings: { pinShape:'circle', colorScheme:'default', lineStyle:'dashed', lineWidth:2, lineOpacity:0.5, pinOpacity:0.85, pinBorderWidth:1, pinBorderColor:'#000', showLabels:false, labelType:'number', glowEffect:false, fillStyle:'solid' },
      pinSize:5, showRouteLines:false, showRouteDetails:true, showAllProperties:false,
      mapTheme:'dark', navigationApp:'apple', quickFilter:'all',
      soldDateFilter:null, highlightRecentlySold:false, showZipOverlay:false,
    });
  };

  const activeScheme = COLOR_SCHEMES.find(s => s.id === (ms.colorScheme || 'default')) || COLOR_SCHEMES[0];

  /* ── tab state ── */
  const [tab, setTab] = useState('appearance');
  const tabs = [
    { id: 'appearance', label: 'Appearance' },
    { id: 'filters', label: 'Filters' },
    { id: 'preferences', label: 'Prefs' },
  ];

  return (
    <div className="fixed inset-0 z-[2000]">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute top-0 right-0 bottom-0 w-full max-w-sm overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl animate-in slide-in-from-right duration-300 flex flex-col" style={{ background:'#0a0a0a', borderLeft:'1px solid rgba(255,255,255,0.06)' }}>

        {/* Header */}
        <div className="px-5 py-4 flex items-center justify-between border-b border-white/[0.06] shrink-0">
          <h2 className="text-sm font-black text-white uppercase tracking-widest">Settings</h2>
          <div className="flex items-center gap-2">
            <button onClick={handleReset} className="text-[9px] font-bold text-gray-500 hover:text-white flex items-center gap-1 px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] transition-colors">
              <RotateCcw className="w-3 h-3" /> Reset
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-white/[0.06] rounded-lg transition-colors">
              <X className="w-4 h-4 text-gray-400" />
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div className="px-4 pt-3 pb-1 flex gap-1 bg-[#0a0a0a] border-b border-white/[0.04] shrink-0">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex-1 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${tab === t.id ? 'bg-white text-black' : 'text-gray-500 hover:text-white hover:bg-white/[0.04]'}`}
            >{t.label}</button>
          ))}
        </div>

        {/* Content */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-4 space-y-5">

            {/* ═══════════ APPEARANCE TAB ═══════════ */}
            {tab === 'appearance' && (<>

              {/* Labels */}
              <div>
                <SectionLabel>Labels & Overlays</SectionLabel>
                <div className="space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                  {setShowZipOverlay && (
                    <Row label="Zip Boundaries">
                      <Switch checked={local.showZipOverlay} onCheckedChange={setLiveZip} />
                    </Row>
                  )}
                  <Row label="Pin Labels">
                    <Switch checked={ms.showLabels || false} onCheckedChange={v => updMs('showLabels', v)} />
                  </Row>
                  {ms.showLabels && (
                    <Row label="Content">
                      <div className="flex gap-1">
                        {['number','address','status'].map(opt => (
                          <button key={opt} onClick={() => updMs('labelType', opt)}
                            className={`px-3 py-1.5 rounded-lg text-[10px] font-bold border transition-all ${(ms.labelType||'number') === opt ? 'bg-white/10 border-white/20 text-white' : 'border-white/[0.06] text-gray-500'}`}
                          >{opt === 'number' ? 'House #' : opt === 'address' ? 'Street' : 'Status'}</button>
                        ))}
                      </div>
                    </Row>
                  )}
                </div>
              </div>

              {/* Map Style */}
              <div>
                <SectionLabel>Map Style</SectionLabel>
                <div className="grid grid-cols-4 gap-2">
                  {MAP_STYLES.map(s => {
                    const Icon = s.icon;
                    const active = local.mapTheme === s.id;
                    return (
                      <button key={s.id} onClick={() => upd('mapTheme', s.id)}
                        className={`flex flex-col items-center gap-1.5 py-3 rounded-xl text-[10px] font-bold transition-all border ${active ? 'bg-white/10 border-white/20 text-white' : 'bg-white/[0.02] border-white/[0.04] text-gray-500 hover:border-white/10'}`}
                      >
                        <Icon className="w-4 h-4" />
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Pin Settings */}
              <div>
                <SectionLabel>Pins</SectionLabel>
                <div className="space-y-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                  <Row label="Show Pins">
                    <Switch checked={local.showRouteDetails} onCheckedChange={v => upd('showRouteDetails', v)} />
                  </Row>
                  <Row label="Pin Size" value={`${local.pinSize}px`}>
                    <Slider value={[local.pinSize]} onValueChange={([v]) => upd('pinSize', v)} min={2} max={14} step={1} className="w-full" />
                  </Row>
                  <Row label="Opacity" value={`${Math.round((ms.pinOpacity || 0.85) * 100)}%`}>
                    <Slider value={[(ms.pinOpacity || 0.85) * 100]} onValueChange={([v]) => updMs('pinOpacity', v / 100)} min={20} max={100} step={5} className="w-full" />
                  </Row>
                  <Row label="Fill Style">
                    <div className="flex gap-1.5">
                      {['solid','outline','glow'].map(s => (
                        <button key={s} onClick={() => updMs('fillStyle', s)}
                          className={`px-3 py-1.5 rounded-lg text-[10px] font-bold border transition-all ${(ms.fillStyle||'solid') === s ? 'bg-white/10 border-white/20 text-white' : 'bg-transparent border-white/[0.06] text-gray-500'}`}
                        >{s}</button>
                      ))}
                    </div>
                  </Row>
                  <Row label="Border" value={`${ms.pinBorderWidth || 1}px`}>
                    <Slider value={[ms.pinBorderWidth || 1]} onValueChange={([v]) => updMs('pinBorderWidth', v)} min={0} max={4} step={0.5} className="w-full" />
                  </Row>
                </div>
              </div>

              {/* Route Lines */}
              <div>
                <SectionLabel>Route Lines</SectionLabel>
                <div className="space-y-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                  <Row label="Show Lines">
                    <Switch checked={local.showRouteLines} onCheckedChange={v => upd('showRouteLines', v)} />
                  </Row>
                  {local.showRouteLines && (<>
                    <Row label="Pattern">
                      <div className="flex gap-1">
                        {LINE_STYLES.map(ls => (
                          <button key={ls.id} onClick={() => updMs('lineStyle', ls.id)}
                            className={`flex-1 py-2 rounded-lg border transition-all ${(ms.lineStyle||'solid') === ls.id ? 'bg-white/10 border-white/20' : 'border-white/[0.04]'}`}
                          >
                            <svg width="100%" height="4" className="px-2"><line x1="0" y1="2" x2="100%" y2="2" stroke={(ms.lineStyle||'solid') === ls.id ? '#fff' : '#555'} strokeWidth="2" strokeDasharray={ls.da || 'none'} /></svg>
                          </button>
                        ))}
                      </div>
                    </Row>
                    <Row label="Thickness" value={`${ms.lineWidth || 2}px`}>
                      <Slider value={[ms.lineWidth || 2]} onValueChange={([v]) => updMs('lineWidth', v)} min={1} max={6} step={0.5} className="w-full" />
                    </Row>
                    <Row label="Opacity" value={`${Math.round((ms.lineOpacity || 0.5) * 100)}%`}>
                      <Slider value={[(ms.lineOpacity || 0.5) * 100]} onValueChange={([v]) => updMs('lineOpacity', v / 100)} min={10} max={100} step={5} className="w-full" />
                    </Row>
                  </>)}
                </div>
              </div>

              {/* Color Scheme */}
              <div>
                <SectionLabel>Color Scheme</SectionLabel>
                <div className="space-y-2">
                  {COLOR_SCHEMES.map(scheme => (
                    <button key={scheme.id} onClick={() => updMs('colorScheme', scheme.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all border ${(ms.colorScheme||'default') === scheme.id ? 'bg-white/[0.06] border-white/15' : 'bg-white/[0.02] border-white/[0.04] hover:border-white/10'}`}
                    >
                      <div className="flex gap-1">{Object.values(scheme.colors).slice(0, 4).map((c, i) => <div key={i} className="w-3.5 h-3.5 rounded-full" style={{ background: c }} />)}</div>
                      <span className={`text-xs font-bold ${(ms.colorScheme||'default') === scheme.id ? 'text-white' : 'text-gray-500'}`}>{scheme.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Team Colors */}
              {teamMembers.length > 0 && (
                <div>
                  <SectionLabel>Team Pin Colors</SectionLabel>
                  <div className="space-y-2">
                    {teamMembers.map(member => (
                      <div key={member.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-3.5 h-3.5 rounded-full border border-white/20" style={{ background: repColors[member.id] || '#FFD700' }} />
                          <span className="text-xs font-bold text-white">{member.name}</span>
                          <span className="text-[9px] text-gray-600 ml-auto">{member.role}</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {REP_COLOR_OPTIONS.map(color => (
                            <button key={color} onClick={() => onUpdateRepColor(member.id, color)}
                              className={`w-6 h-6 rounded-full transition-all ${repColors[member.id] === color ? 'ring-2 ring-white ring-offset-1 ring-offset-black scale-110' : 'hover:scale-110'}`}
                              style={{ background: color }}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>)}

            {/* ═══════════ FILTERS TAB ═══════════ */}
            {tab === 'filters' && (<>
              {/* Status Filter */}
              <div>
                <SectionLabel>Status Visibility</SectionLabel>
                <div className="grid grid-cols-2 gap-2">
                  {STATUS_FILTERS.map(f => (
                    <button key={f.id} onClick={() => setLiveQuickFilter(f.id)}
                      className={`flex items-center gap-2 px-3 py-3 rounded-xl text-xs font-bold transition-all border ${local.quickFilter === f.id ? 'bg-white/[0.08] border-white/15 text-white' : 'bg-white/[0.02] border-white/[0.04] text-gray-500 hover:border-white/10'}`}
                    >
                      <div className="w-2.5 h-2.5 rounded-full" style={{ background: f.color }} />
                      {f.label}
                      {local.quickFilter === f.id ? <Eye className="w-3 h-3 ml-auto" /> : <EyeOff className="w-3 h-3 ml-auto opacity-30" />}
                    </button>
                  ))}
                </div>
              </div>

              {/* Toggles */}
              <div>
                <SectionLabel>Display Options</SectionLabel>
                <div className="space-y-1 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                  <Row label="Show All Properties" sub="Pins not in any route">
                    <Switch checked={local.showAllProperties} onCheckedChange={setLiveShowAll} />
                  </Row>
                  <div className="border-t border-white/[0.04] my-2" />
                  <Row label="Highlight Recently Sold" sub="Magenta for last 30 days">
                    <Switch checked={local.highlightRecentlySold} onCheckedChange={setLiveHighlight} />
                  </Row>
                </div>
              </div>

              {/* Sold Date */}
              {setSoldDateFilter && (
                <div>
                  <SectionLabel>Sold Date Window</SectionLabel>
                  <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                    <select
                      value={local.soldDateFilter || 'all'}
                      onChange={(e) => setLiveSoldDateFilter(e.target.value === 'all' ? null : parseInt(e.target.value))}
                      className="w-full h-10 px-3 text-xs font-bold bg-black/40 border border-white/5 text-white rounded-xl outline-none focus:border-white/15 cursor-pointer [color-scheme:dark]"
                    >
                      <option value="all">All Time (No Filter)</option>
                      <option value="1">Last 1 Month</option>
                      <option value="3">Last 3 Months</option>
                      <option value="6">Last 6 Months</option>
                      <option value="9">Last 9 Months</option>
                      <option value="12">Last 1 Year</option>
                      <option value="24">Last 2 Years</option>
                      <option value="36">Last 3 Years</option>
                    </select>
                  </div>
                </div>
              )}
            </>)}

            {/* ═══════════ PREFERENCES TAB ═══════════ */}
            {tab === 'preferences' && (<>
              <div>
                <SectionLabel>Navigation App</SectionLabel>
                <div className="grid grid-cols-2 gap-2">
                  {[{ id:'apple', label:'Apple Maps' }, { id:'google', label:'Google Maps' }].map(opt => (
                    <button key={opt.id} onClick={() => upd('navigationApp', opt.id)}
                      className={`py-3 rounded-xl text-xs font-bold transition-all border ${local.navigationApp === opt.id ? 'bg-white/10 border-white/20 text-white' : 'bg-white/[0.02] border-white/[0.04] text-gray-500 hover:border-white/10'}`}
                    >{opt.label}</button>
                  ))}
                </div>
              </div>

              <div>
                <SectionLabel>Builder Behavior</SectionLabel>
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                  <Row label="Auto-build on Generate" sub="Build immediately when clicking Generate">
                    <Switch checked={!!(ms.autoBuildOnGenerateButton)} onCheckedChange={v => updMs('autoBuildOnGenerateButton', v)} />
                  </Row>
                </div>
              </div>
            </>)}

          </div>
        </ScrollArea>

        {/* Save Footer */}
        <div className="p-4 border-t border-white/[0.06] shrink-0 bg-[#0a0a0a]">
          <Button onClick={handleSave} className="w-full font-bold h-11 bg-white hover:bg-gray-200 text-black rounded-xl">
            <Save className="w-4 h-4 mr-2" /> Save Settings
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── helper: row ── */
function Row({ label, sub = null, value = null, children }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs font-semibold text-gray-300">{label}</span>
          {sub && <p className="text-[9px] text-gray-600">{sub}</p>}
        </div>
        {value && <span className="text-[10px] font-bold text-gray-400">{value}</span>}
      </div>
      {children}
    </div>
  );
}