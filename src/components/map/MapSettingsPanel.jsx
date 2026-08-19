import React, { useEffect, useState } from 'react';
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { X, Eye, EyeOff, RotateCcw, Save, Navigation, Home, SlidersHorizontal } from 'lucide-react';
import HomeBaseDialog from '@/components/routes/HomeBaseDialog';
import MapStyleSelector from '@/components/map/MapStyleSelector';
import MapThemePicker from '@/components/map/MapThemePicker';
import { DEFAULT_PIN_THEME, DEFAULT_PRECISION_PIN_THEME } from '@/components/map/mapPinThemes';
import MapOverlayToggles from '@/components/map/MapOverlayToggles';
import RouteModeSetting from '@/components/map/RouteModeSetting';
import { getBoundaryOverlays, setBoundaryOverlay } from '@/components/map/boundaryOverlayPrefs';
import { markPinSizeUserSet, clearPinSizeUserSet } from '@/components/map/densePinSize';

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
  { id: 'all', label: 'All Statuses', color: '#E5E5E5' },
  { id: 'eligible', label: 'ELIGIBLE', color: '#404040' },
  { id: 'sold', label: 'SOLD', color: '#22c55e' },
  { id: 'no_answer', label: 'NO_ANSWER', color: '#3b82f6' },
  { id: 'callback', label: 'CALLBACK', color: '#eab308' },
  { id: 'hard_no', label: 'HARD_NO', color: '#8B5CF6' },
  { id: 'not_moved_in', label: 'NOT_MOVED_IN', color: '#FFBC66' },
  { id: 'dm_not_home', label: 'DM_NOT_HOME', color: '#06b6d4' },
];

/* ── sub-component: section header ── */
function SectionLabel({ children }) {
  return <h4 className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mb-3 mt-1">{children}</h4>;
}

/* ── main panel ── */
export default function MapSettingsPanel({
  routeMode = 'precision',
  mapTheme, setMapTheme,
  teamMembers, repColors, onUpdateRepColor,
  onClose,
  quickFilter, setQuickFilter,
  showRouteDetails, setShowRouteDetails,
  showAllProperties, setShowAllProperties,
  navigationApp, setNavigationApp,
  pinSize = 4, setPinSize,
  showRouteLines = false, setShowRouteLines,
  mapSettings, setMapSettings,
  soldDateFilter, setSoldDateFilter,
  highlightRecentlySold, setHighlightRecentlySold,
  homeBase = null, onSaveHomeBase,
}) {
  // Boundary overlays are per-device display prefs, applied live.
  const [overlays, setOverlays] = useState(getBoundaryOverlays);
  const toggleOverlay = (name) => (value) => setOverlays(setBoundaryOverlay(name, value));
  const [showHomeBase, setShowHomeBase] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Local buffered state
  const [local, setLocal] = useState({
    mapSettings: mapSettings || {},
    pinSize, showRouteLines, showRouteDetails, showAllProperties,
    mapTheme, navigationApp, quickFilter,
    soldDateFilter, highlightRecentlySold,
  });

  const upd = (key, val) => setLocal(p => ({ ...p, [key]: val }));
  const updMs = (key, val) => setLocal(p => ({ ...p, mapSettings: { ...p.mapSettings, [key]: val } }));
  const setLiveMapTheme = (value) => { upd('mapTheme', value); setMapTheme?.(value); };

  useEffect(() => {
    if (!window.matchMedia('(min-width: 1024px)').matches) return undefined;
    window.dispatchEvent(new Event('resize'));
    return () => { setTimeout(() => window.dispatchEvent(new Event('resize')), 0); };
  }, []);

  const ms = local.mapSettings;

  // Live filter updates
  const setLiveQuickFilter = (v) => { upd('quickFilter', v); setQuickFilter?.(v); };
  const setLiveSoldDateFilter = (v) => {
    upd('soldDateFilter', v);
    setSoldDateFilter?.(v);
  };
  const setLiveShowAll = (v) => { upd('showAllProperties', v); setShowAllProperties?.(v); };
  const setLiveHighlight = (v) => { upd('highlightRecentlySold', v); setHighlightRecentlySold?.(v); };
  // A theme is the dots, the paths, and the colour scheme applied together.
  // Picking one is an explicit dot-size choice, so it overrides the automatic
  // dense-territory size the map applies on its own.
  const applyTheme = (theme) => {
    markPinSizeUserSet();
    setLocal(p => ({ ...p, mapSettings: { ...p.mapSettings, ...theme.settings }, pinSize: theme.pinSize }));
  };

  const handleSave = () => {
    setMapSettings?.(local.mapSettings);
    setPinSize?.(local.pinSize);
    setShowRouteLines?.(local.showRouteLines);
    setShowRouteDetails?.(local.showRouteDetails);
    setShowAllProperties?.(local.showAllProperties);
    setMapTheme?.(local.mapTheme);
    setNavigationApp?.(local.navigationApp);
    setHighlightRecentlySold?.(local.highlightRecentlySold);
    try { localStorage.setItem('fk_navigation_app', local.navigationApp); } catch {}
    window.dispatchEvent(new CustomEvent('fk-navigation-app-changed', { detail: { navigationApp: local.navigationApp } }));
    onClose();
  };

  const handleReset = () => {
    // Back to defaults includes handing dot sizing back to the automatic
    // dense-territory rule.
    clearPinSizeUserSet();
    const defaultMapTheme = routeMode === 'canvas' ? 'terrain' : 'hybrid';
    const defaultPinTheme = routeMode === 'canvas' ? DEFAULT_PIN_THEME : DEFAULT_PRECISION_PIN_THEME;
    setMapTheme?.(defaultMapTheme);
    setLocal({
      mapSettings: { pinShape:'circle', showLabels:false, labelType:'number', ...defaultPinTheme.settings },
      pinSize:defaultPinTheme.pinSize, showRouteLines:false, showRouteDetails:true, showAllProperties:false,
      mapTheme:defaultMapTheme, navigationApp:'apple', quickFilter:'all',
      soldDateFilter:null, highlightRecentlySold:false,
    });
  };

  const resetDataFilters = () => {
    setLiveQuickFilter('all');
    setLiveShowAll(false);
    setLiveHighlight(false);
    setLiveSoldDateFilter(null);
    setOverlays(setBoundaryOverlay('zip', false));
    setOverlays(setBoundaryOverlay('county', false));
  };

  /* ── tab state ── */
  const [tab, setTab] = useState('appearance');
  const tabs = [
    { id: 'appearance', label: 'Map' },
    { id: 'filters', label: 'Data' },
  ];

  return (
    <div className="fixed inset-0 z-[2000] lg:left-auto lg:w-96">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm lg:hidden" onClick={onClose} />
      <div className="absolute top-0 right-0 bottom-0 w-full max-w-sm overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl animate-in slide-in-from-right duration-300 flex flex-col" style={{ background:'#0a0a0a', borderLeft:'1px solid rgba(255,255,255,0.06)' }}>

        {/* Header */}
        <div className="px-5 py-4 flex items-center justify-between border-b border-white/[0.06] shrink-0">
          <div>
            <h2 className="text-sm font-black text-white uppercase tracking-widest">Map Settings</h2>
            <p className="text-[10px] text-gray-500 mt-0.5">Display, filters, and route preferences</p>
          </div>
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
        {/* Radix lays its scroll content out as a table, which lets wide rows
            grow past the sheet and run off the right edge of a phone screen.
            Forcing the content wrapper to block keeps everything inside. */}
        <ScrollArea className="flex-1 min-h-0 w-full [&>div>div]:!block">
          <div className="w-full max-w-full overflow-x-hidden p-4 space-y-5">

            {/* ═══════════ APPEARANCE TAB ═══════════ */}
            {tab === 'appearance' && (<>

              {/* Route Mode — switch between Canvas and Precision territory building */}
              <RouteModeSetting />

              {/* Navigation Provider — first, because it drives every Navigate button */}
              <div>
                <SectionLabel>Navigation App</SectionLabel>
                <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2">
                  {[{ id:'apple', label:'Apple Maps' }, { id:'google', label:'Google Maps' }].map(opt => (
                    <button key={opt.id} onClick={() => { upd('navigationApp', opt.id); setNavigationApp?.(opt.id); try { localStorage.setItem('fk_navigation_app', opt.id); } catch {} window.dispatchEvent(new CustomEvent('fk-navigation-app-changed', { detail: { navigationApp: opt.id } })); }}
                      className={`flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-bold transition-all border ${local.navigationApp === opt.id ? 'bg-white/10 border-white/20 text-white' : 'bg-black/20 border-white/[0.04] text-gray-500 hover:border-white/10'}`}
                    >
                      <Navigation className="w-3.5 h-3.5" />
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[9px] text-gray-600 leading-relaxed">Used by Route Checklist and Knock tab navigation buttons.</p>
              </div>

              {/* Home Base — the start/finish used by "Optimize from Home" */}
              {onSaveHomeBase && (
                <div>
                  <SectionLabel>Home Base</SectionLabel>
                  <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                    <p className="text-xs font-semibold text-gray-300 truncate">
                      {homeBase?.address || (homeBase ? `${Number(homeBase.lat).toFixed(4)}, ${Number(homeBase.lng).toFixed(4)}` : 'Not set')}
                    </p>
                    <p className="mt-1 text-[9px] leading-relaxed text-gray-600">
                      Used when you optimize a route from home — it starts at the closest door to this address and finishes at the closest door on the way back.
                    </p>
                    <button
                      onClick={() => setShowHomeBase(true)}
                      className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-[#2EEB57] text-[10px] font-black uppercase tracking-wider text-black hover:bg-[#39FF4A]"
                    >
                      <Home className="w-3.5 h-3.5" /> {homeBase ? 'Change Home Base' : 'Set Home Base'}
                    </button>
                  </div>
                </div>
              )}

              {/* Map Style */}
              <div>
                <SectionLabel>{routeMode === 'canvas' ? 'Canvas Light Variants & Map Style' : 'Map Style'}</SectionLabel>
                <MapStyleSelector routeMode={routeMode} value={local.mapTheme} onChange={setLiveMapTheme} />
                {routeMode === 'canvas' && <p className="mt-2 text-[9px] leading-relaxed text-gray-600">Select any light treatment to compare saturation, warmth, and contrast directly on the map.</p>}
              </div>

              {/* Overlays — boundaries and labels, side by side */}
              <div>
                <SectionLabel>Overlays</SectionLabel>
                <MapOverlayToggles
                  showZipOverlay={overlays.zip}
                  onToggleZip={toggleOverlay('zip')}
                  showCountyOverlay={overlays.county}
                  onToggleCounty={toggleOverlay('county')}
                  showLabels={ms.showLabels || false}
                  onToggleLabels={v => updMs('showLabels', v)}
                  labelType={ms.labelType}
                  onChangeLabelType={v => updMs('labelType', v)}
                />
              </div>

              {/* Pin Themes — dots, paths, and colours as one matched set */}
              <div>
                <SectionLabel>Pin Theme</SectionLabel>
                <MapThemePicker mapSettings={ms} pinSize={local.pinSize} onApply={applyTheme} />
              </div>

              {/* The show/hide switches that belong with the theme */}
              <div className="space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <Row label="Show route dots">
                  <Switch checked={local.showRouteDetails} onCheckedChange={v => upd('showRouteDetails', v)} />
                </Row>
                <div className="border-t border-white/[0.04]" />
                <Row label="Show route paths">
                  <Switch checked={local.showRouteLines} onCheckedChange={v => upd('showRouteLines', v)} />
                </Row>
              </div>

              {/* Fine-tuning, collapsed by default so a theme is the normal path */}
              <button
                onClick={() => setShowAdvanced(v => !v)}
                className="flex w-full items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-gray-400 hover:text-white"
              >
                <span className="flex items-center gap-2"><SlidersHorizontal className="h-3.5 w-3.5" /> Fine-tune dots &amp; paths</span>
                <span className="text-sm">{showAdvanced ? '−' : '+'}</span>
              </button>

              {showAdvanced && (<>
                {/* Dots */}
                <div>
                  <SectionLabel>Property Dots</SectionLabel>
                  <div className="space-y-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                    <Row label="Dot size" value={`${local.pinSize}px`}>
                      <Slider value={[local.pinSize]} onValueChange={([v]) => { markPinSizeUserSet(); upd('pinSize', v); }} min={2} max={14} step={1} className="w-full" />
                    </Row>
                    <Row label="Dot opacity" value={`${Math.round((ms.pinOpacity || 0.85) * 100)}%`}>
                      <Slider value={[(ms.pinOpacity || 0.85) * 100]} onValueChange={([v]) => updMs('pinOpacity', v / 100)} min={20} max={100} step={5} className="w-full" />
                    </Row>
                    <Row label="Fill Style">
                      <div className="flex flex-wrap gap-1.5">
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

                {/* Paths */}
                <div>
                  <SectionLabel>Route Paths</SectionLabel>
                  <div className="space-y-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
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
                  </div>
                </div>

                {/* Status colours */}
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
              </>)}

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
              <button
                onClick={resetDataFilters}
                className="w-full h-11 rounded-xl bg-[#2EEB57] hover:bg-[#39FF4A] text-black text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 shadow-[0_0_18px_rgba(46,235,87,0.25)]"
              >
                <RotateCcw className="w-4 h-4" /> Reset All Filters
              </button>

              {/* Status Filter */}
              <div>
                <SectionLabel>Pin Status Filter</SectionLabel>
                <p className="text-[9px] text-gray-600 mb-3">Shows/hides property pins by decision status</p>
                <div className="space-y-2">
                  {STATUS_FILTERS.map(f => (
                    <button key={f.id} onClick={() => setLiveQuickFilter(f.id)}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-bold transition-all border w-full ${local.quickFilter === f.id ? 'bg-white/[0.08] border-white/15 text-white' : 'bg-white/[0.02] border-white/[0.04] text-gray-500 hover:border-white/10'}`}
                    >
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: f.color }} />
                      <span className="flex-1 text-left">{f.label}</span>
                      {local.quickFilter === f.id ? <Eye className="w-4 h-4 shrink-0" /> : <EyeOff className="w-4 h-4 shrink-0 opacity-30" />}
                    </button>
                  ))}
                </div>
              </div>

              {/* Toggles */}
              <div>
               <SectionLabel>Extra Display Options</SectionLabel>
               <div className="space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                 <Row label="Show All Properties" sub="Include pins not in any route">
                   <Switch checked={local.showAllProperties} onCheckedChange={setLiveShowAll} />
                 </Row>
                 <div className="border-t border-white/[0.04] my-2" />
                 <Row label="Highlight Recently Sold" sub="Last 30 days in magenta">
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
                    </select>
                  </div>
                </div>
              )}
            </>)}

          </div>
        </ScrollArea>

        {/* Save Footer */}
        <div className="p-4 border-t border-white/[0.06] shrink-0 bg-[#0a0a0a]">
          <Button onClick={handleSave} className="w-full font-bold h-11 bg-white hover:bg-gray-200 text-black rounded-xl">
            <Save className="w-4 h-4 mr-2" /> Save Settings
          </Button>
        </div>

        {showHomeBase && (
          <HomeBaseDialog
            homeBase={homeBase}
            onClose={() => setShowHomeBase(false)}
            onSave={onSaveHomeBase}
          />
        )}
      </div>
    </div>
  );
}

/* ── helper: row ── */
function Row({ label, sub = null, value = null, children }) {
  return (
    <div className="w-full min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="text-xs font-semibold text-gray-300">{label}</span>
          {sub && <p className="text-[9px] text-gray-600">{sub}</p>}
        </div>
        {value && <span className="shrink-0 text-[10px] font-bold text-gray-400">{value}</span>}
      </div>
      {children}
    </div>
  );
}