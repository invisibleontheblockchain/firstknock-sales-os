import React from 'react';
import { CarFront, Home, Route as RouteIcon, X, Zap } from 'lucide-react';

import { OPTIMIZE_MODES } from '@/lib/routeOriginModes';

/**
 * The three optimization choices behind the active-route Optimize button.
 *
 * Clicking Optimize no longer reorders the route. It expands this panel, and the
 * route only changes once a mode is chosen — the anchor is part of the order, so
 * choosing it implicitly was the thing that made the old button unpredictable.
 *
 * The panel is deliberately rendered IN FLOW, beneath the banner's first row,
 * exactly like the existing RERUN panel. An earlier attempt used a
 * `position: fixed` bottom sheet, which broke: the banner sets `backdrop-blur`,
 * and a backdrop-filter makes an element the containing block for its fixed
 * descendants, so the sheet sized itself against the ~380x76px banner instead of
 * the viewport and pushed two of the three choices off the top of the screen.
 * Nothing here is fixed, portaled or overlaid, so no ancestor filter, transform
 * or overflow can move it.
 */
export const OPTIMIZE_CHOICES = [
    {
        mode: OPTIMIZE_MODES.ROUTE_ONLY,
        label: 'ROUTE',
        hint: 'Doors only',
        description: 'Optimize only the walking order of the doors. No outside starting or finishing location.',
        Icon: RouteIcon
    },
    {
        mode: OPTIMIZE_MODES.HOME_ROUND_TRIP,
        label: 'HOME',
        hint: 'Start & end home',
        description: 'Start at Home Base, knock the route, and finish back at Home Base.',
        Icon: Home
    },
    {
        mode: OPTIMIZE_MODES.CAR_ROUND_TRIP,
        label: 'MY CAR',
        hint: 'Start & end at car',
        description: 'Use your current GPS as the parked-car start and finish.',
        Icon: CarFront
    }
];

/**
 * The map must not pan, zoom or refit because a toolbar control was touched.
 * Same guard the surrounding buttons already use.
 */
function stopMapInteraction(event) {
    window.__fkSuppressMapFitUntil = Date.now() + 1500;
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent?.stopImmediatePropagation?.();
}

/**
 * The Optimize button itself. Styling is unchanged from the single-action button
 * it replaces, so the collapsed banner is pixel-identical; it only gains a caret
 * and the expanded/collapsed ARIA state.
 *
 * Rendered once per breakpoint rather than emitting both variants together,
 * because the two buttons did not sit in the same place: mobile came before
 * EXPORT and desktop came after it. Emitting both from one position would
 * silently reorder the desktop row.
 */
export function OptimizeRouteTrigger({ variant, open = false, busy = false, onToggle }) {
    const toggle = (event) => {
        stopMapInteraction(event);
        if (!busy) onToggle?.();
    };
    const mobile = variant === 'mobile';

    return (
        <button
            type="button"
            aria-haspopup="true"
            aria-expanded={open}
            disabled={busy}
            data-testid={`optimize-trigger-${variant}`}
            onPointerDown={stopMapInteraction}
            onTouchStart={mobile
                ? (e) => {window.__fkSuppressMapFitUntil = Date.now() + 1500;e.stopPropagation();e.nativeEvent?.stopImmediatePropagation?.();}
                : undefined}
            onClick={toggle}
            className={mobile
                ? 'md:hidden flex h-6 shrink-0 items-center gap-0.5 rounded-lg bg-[#111] px-2 text-[10px] font-extrabold text-[#39FF4A] border border-[#2EEB57]/30 hover:bg-[#222] touch-manipulation select-none active:scale-95 disabled:opacity-50'
                : 'hidden md:flex h-7 px-2 text-[10px] font-bold bg-[#111] hover:bg-[#222] text-[#39FF4A] border border-[#2EEB57]/30 rounded-md items-center gap-1 touch-manipulation select-none active:scale-95 disabled:opacity-50'}
            title="Optimize">

            <Zap className={mobile ? 'w-3 h-3' : 'w-2.5 h-2.5'} /><span>OPTIMIZE</span><span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
    );
}

/**
 * The expanded choices, rendered in normal flow beneath the banner's first row.
 *
 * @param {(mode: string) => void} onSelectMode
 * @param {boolean} carDisabled       true when the route is assigned to someone else
 * @param {string}  carDisabledReason shown in place of the description
 * @param {boolean} busy              suppresses duplicate submissions
 */
export function OptimizeRouteChoices({
    onSelectMode,
    onCancel,
    carDisabled = false,
    carDisabledReason = 'The assigned rep must optimize this route from their car on their device.',
    busy = false
}) {
    return (
        <div
            data-testid="optimize-choices"
            role="group"
            aria-label="Optimize route"
            className="mt-2 rounded-xl border border-white/10 bg-black/45 p-2"
            onClick={(e) => {e.stopPropagation();e.nativeEvent?.stopImmediatePropagation?.();}}
            onTouchStart={(e) => {e.stopPropagation();e.nativeEvent?.stopImmediatePropagation?.();}}>

            <div className="grid grid-cols-3 gap-1.5">
                {OPTIMIZE_CHOICES.map(({ mode, label, hint, description, Icon }) => {
                    const disabled = busy || (mode === OPTIMIZE_MODES.CAR_ROUND_TRIP && carDisabled);
                    const isCarRefusal = mode === OPTIMIZE_MODES.CAR_ROUND_TRIP && carDisabled;
                    return (
                        <button
                            key={mode}
                            type="button"
                            data-optimize-mode={mode}
                            disabled={disabled}
                            title={isCarRefusal ? carDisabledReason : description}
                            onPointerDown={stopMapInteraction}
                            onClick={(event) => {
                                stopMapInteraction(event);
                                if (!disabled) onSelectMode?.(mode);
                            }}
                            className={`rounded-lg border px-2 py-2 text-left touch-manipulation ${
                                disabled
                                    ? 'border-white/10 bg-white/[0.02] opacity-40 cursor-not-allowed'
                                    : 'border-white/10 bg-white/[0.04] hover:border-[#2EEB57]/45 hover:bg-[#2EEB57]/10 active:scale-[0.98]'}`}>

                            <Icon className="w-3.5 h-3.5 mb-1 text-[#39FF4A]" />
                            <span className="block text-[10px] font-black text-white/80">{label}</span>
                            <span className="block text-[9px] leading-tight text-white/40">
                                {isCarRefusal ? 'Assigned rep only' : hint}
                            </span>
                        </button>
                    );
                })}
            </div>
            <button
                type="button"
                data-testid="optimize-cancel"
                onPointerDown={stopMapInteraction}
                onClick={(event) => {stopMapInteraction(event);onCancel?.();}}
                className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-lg border border-white/10 px-2 py-1.5 text-[10px] font-bold text-gray-400 hover:bg-white/10 hover:text-white touch-manipulation active:scale-[0.99]">

                <X className="w-3 h-3" /><span>CANCEL</span>
            </button>
        </div>
    );
}