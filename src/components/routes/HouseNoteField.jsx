import React from 'react';
import { ChevronUp } from 'lucide-react';

/**
 * "Add Details" note field for a checklist stop.
 *
 * Same affordance as the knock tab; the note persists as
 * InteractionLog.description. It sits under Log outcome so the decision grid
 * stays the first thing in reach.
 */
export default function HouseNoteField({
  property,
  open,
  onToggle,
  value,
  savedNote,
  noteState,
  noteBadge,
  noteError,
  onChange,
  onFlush,
}) {
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`house-note-panel-${property.address_hash}`}
        className="w-full flex items-center justify-between rounded-xl border border-[#2EEB57]/35 bg-[#2EEB57]/10 px-3 py-2.5 text-left active:scale-[0.99] transition-all"
      >
        <span className="flex items-center gap-2">
          <span className="text-[10px] font-black uppercase tracking-[0.18em] text-white">Add Details</span>
          {/* Never colour alone: the state is named, not just tinted. */}
          {noteBadge && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[9px] font-bold"
              style={noteState === 'error'
                ? { background: 'rgba(255,107,107,0.15)', color: '#FF6B6B' }
                : { background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.7)' }}
            >
              {noteBadge}
            </span>
          )}
        </span>
        <ChevronUp className={`w-4 h-4 text-white transition-transform ${open ? '' : 'rotate-180'}`} />
      </button>

      {open && (
        <div id={`house-note-panel-${property.address_hash}`} className="space-y-1">
          <textarea
            id={`house-note-${property.address_hash}`}
            value={value}
            onChange={(e) => onChange(property, e.target.value)}
            onBlur={() => onFlush(property)}
            placeholder="Gate code, who decides, best time to return..."
            rows={3}
            autoFocus
            className="selectable-text w-full resize-none rounded-xl border border-[#2EEB57]/25 bg-black/70 p-3 text-[12px] text-white outline-none focus:border-[#39FF4A]"
          />
          <p
            className="text-[9px]"
            role={noteState === 'error' ? 'alert' : undefined}
            style={{ color: noteState === 'error' ? '#FF6B6B' : '#555' }}
          >
            {noteState === 'error'
              ? `Not saved — ${noteError || 'the server rejected this note'}`
              : noteState === 'saving'
                ? 'Saving...'
                : 'Saved automatically to this house.'}
          </p>
        </div>
      )}

      {!open && savedNote && (
        <p className="truncate px-1 text-[10px] italic" style={{ color: '#777' }}>"{savedNote}"</p>
      )}
    </div>
  );
}