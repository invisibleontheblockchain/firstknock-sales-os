import React from 'react';

function formatWhen(value) {
  if (!value) return '';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleDateString();
}

export default function UnifiedSearchResultRow({ result, Icon, active, onSelect, onHover }) {
  const title = result.name || result.formatted_address || 'Unknown';
  const subtitle = result.name ? result.formatted_address : null;
  const lastSeen = formatWhen(result.last_interaction_at);

  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      onClick={onSelect}
      className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors ${active ? 'bg-white/[0.09]' : 'hover:bg-white/[0.05]'}`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${result.type === 'record' ? 'text-[#39FF4A]' : 'text-white/45'}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-bold text-white">{title}</span>
        {subtitle && <span className="mt-0.5 block truncate text-[11px] text-white/50">{subtitle}</span>}
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-white/40">
          {result.status && <span className="uppercase tracking-[0.08em]">{String(result.status).replaceAll('_', ' ')}</span>}
          {result.route_label && <span className="truncate">{result.route_label}</span>}
          {lastSeen && <span>Last activity {lastSeen}</span>}
          {result.type === 'address' && <span>New address</span>}
        </span>
      </span>
    </button>
  );
}