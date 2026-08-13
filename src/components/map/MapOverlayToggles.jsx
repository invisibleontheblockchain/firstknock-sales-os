import React from 'react';
import { Map as MapIcon, Landmark, Tag } from 'lucide-react';

/**
 * The three map overlays that sit side by side: ZIP boundaries, county lines, and
 * pin labels. Each is a tile so they read as one row of switches instead of a
 * stack of unrelated rows.
 */
function OverlayTile({ icon: Icon, label, active, onToggle, disabled = false }) {
  return (
    <button
      onClick={() => !disabled && onToggle(!active)}
      disabled={disabled}
      className={`flex flex-col items-center gap-1.5 rounded-xl border py-3 text-[10px] font-bold transition-all ${active ? 'border-[#2EEB57]/50 bg-[#2EEB57]/[0.1] text-white' : 'border-white/[0.06] bg-white/[0.02] text-gray-500 hover:border-white/15'} ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
    >
      <Icon className={`h-4 w-4 ${active ? 'text-[#2EEB57]' : ''}`} />
      {label}
    </button>
  );
}

export default function MapOverlayToggles({
  showZipOverlay, onToggleZip,
  showCountyOverlay, onToggleCounty,
  showLabels, onToggleLabels,
  labelType, onChangeLabelType,
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <OverlayTile icon={MapIcon} label="Zip Lines" active={Boolean(showZipOverlay)} onToggle={onToggleZip} disabled={!onToggleZip} />
        <OverlayTile icon={Landmark} label="Counties" active={Boolean(showCountyOverlay)} onToggle={onToggleCounty} disabled={!onToggleCounty} />
        <OverlayTile icon={Tag} label="Pin Labels" active={Boolean(showLabels)} onToggle={onToggleLabels} />
      </div>
      {showLabels && (
        <div className="flex gap-1.5">
          {[['number', 'House #'], ['address', 'Street'], ['status', 'Status']].map(([id, label]) => (
            <button
              key={id}
              onClick={() => onChangeLabelType(id)}
              className={`flex-1 rounded-lg border py-1.5 text-[10px] font-bold transition-all ${(labelType || 'number') === id ? 'border-white/20 bg-white/10 text-white' : 'border-white/[0.06] text-gray-500 hover:text-white'}`}
            >{label}</button>
          ))}
        </div>
      )}
    </div>
  );
}