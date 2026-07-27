import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CarFront, Home, Route as RouteIcon, Zap } from 'lucide-react';

import { OPTIMIZE_MODES } from '@/lib/routeOriginModes';

/**
 * The three optimization choices behind the active-route Optimize button.
 *
 * Clicking Optimize no longer reorders the route. It opens this menu, and the
 * route only changes once a mode is chosen — the anchor is part of the order, so
 * choosing it implicitly was the thing that made the old button unpredictable.
 */
export const OPTIMIZE_CHOICES = [
    {
        mode: OPTIMIZE_MODES.ROUTE_ONLY,
        label: 'Route',
        description: 'Optimize only the walking order of the doors. No outside starting or finishing location.',
        Icon: RouteIcon
    },
    {
        mode: OPTIMIZE_MODES.HOME_ROUND_TRIP,
        label: 'From Home',
        description: 'Start at Home Base, knock the route, and finish back at Home Base.',
        Icon: Home
    },
    {
        mode: OPTIMIZE_MODES.CAR_ROUND_TRIP,
        label: 'From My Car',
        description: 'Use your current GPS as the parked-car start and finish.',
        Icon: CarFront
    }
];

function stopMapInteraction(event) {
    window.__fkSuppressMapFitUntil = Date.now() + 1500;
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent?.stopImmediatePropagation?.();
}

function ChoiceRow({ choice, disabled, disabledReason, onSelect, compact }) {
    const { Icon, label, description, mode } = choice;
    return (
        <button
            type="button"
            role="menuitem"
            data-optimize-mode={mode}
            disabled={disabled}
            title={disabled ? disabledReason : undefined}
            onPointerDown={stopMapInteraction}
            onClick={(event) => {
                stopMapInteraction(event);
                if (!disabled) onSelect(mode);
            }}
            className={`w-full text-left flex items-start gap-3 rounded-md px-3 ${compact ? 'py-3' : 'py-2'}
                ${disabled
                    ? 'opacity-40 cursor-not-allowed'
                    : 'hover:bg-white/10 active:scale-[0.99] touch-manipulation'}`}
        >
            <Icon className={`${compact ? 'w-5 h-5' : 'w-4 h-4'} mt-0.5 shrink-0 text-[#39FF4A]`} />
            <span className="min-w-0">
                <span className={`block font-bold text-white ${compact ? 'text-sm' : 'text-xs'}`}>{label}</span>
                <span className={`block text-gray-400 ${compact ? 'text-xs' : 'text-[10px]'} leading-snug`}>
                    {disabled && disabledReason ? disabledReason : description}
                </span>
            </span>
        </button>
    );
}

/**
 * @param {(mode: string) => void} onSelectMode
 * @param {boolean} carDisabled            true when the route is assigned to someone else
 * @param {string}  carDisabledReason      shown in place of the description
 * @param {boolean} busy                   suppresses duplicate submissions
 * @param {boolean} defaultOpen            renders the choices immediately; a test seam
 */
export default function OptimizeRouteMenu({
    onSelectMode,
    carDisabled = false,
    carDisabledReason = 'The assigned rep must optimize this route from their car on their device.',
    busy = false,
    defaultOpen = false
}) {
    const [open, setOpen] = useState(defaultOpen);
    const containerRef = useRef(null);

    const close = useCallback(() => setOpen(false), []);

    useEffect(() => {
        if (!open) return undefined;

        const onKeyDown = (event) => { if (event.key === 'Escape') close(); };
        const onPointerDown = (event) => {
            if (containerRef.current && !containerRef.current.contains(event.target)) close();
        };

        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('pointerdown', onPointerDown, true);
        };
    }, [open, close]);

    const select = useCallback((mode) => {
        if (busy) return;
        close();
        onSelectMode?.(mode);
    }, [busy, close, onSelectMode]);

    const disabledFor = (mode) => mode === OPTIMIZE_MODES.CAR_ROUND_TRIP && carDisabled;

    return (
        <span ref={containerRef} className="relative inline-flex">
            {/* Mobile trigger — stays a first-class button in the banner. */}
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                disabled={busy}
                data-testid="optimize-trigger-mobile"
                onPointerDown={stopMapInteraction}
                onTouchStart={(event) => {
                    window.__fkSuppressMapFitUntil = Date.now() + 1500;
                    event.stopPropagation();
                    event.nativeEvent?.stopImmediatePropagation?.();
                }}
                onClick={(event) => { stopMapInteraction(event); setOpen((value) => !value); }}
                className="md:hidden flex h-8 items-center gap-1 rounded-md bg-[#111] px-2 text-[9px] font-bold text-[#39FF4A] border border-[#2EEB57]/30 hover:bg-[#222] touch-manipulation select-none active:scale-95 disabled:opacity-50"
                title="Optimize"
            >
                <Zap className="w-3 h-3" /><span>OPTIMIZE</span><span aria-hidden="true">▾</span>
            </button>

            {/* Desktop trigger — same position as before, beside Export. */}
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                disabled={busy}
                data-testid="optimize-trigger-desktop"
                onPointerDown={stopMapInteraction}
                onClick={(event) => { stopMapInteraction(event); setOpen((value) => !value); }}
                className="hidden md:flex h-7 px-2 text-[10px] font-bold bg-[#111] hover:bg-[#222] text-[#39FF4A] border border-[#2EEB57]/30 rounded-md items-center gap-1 touch-manipulation select-none active:scale-95 disabled:opacity-50"
                title="Optimize"
            >
                <Zap className="w-2.5 h-2.5" /><span>OPTIMIZE</span><span aria-hidden="true">▾</span>
            </button>

            {open && (
                <>
                    {/* Desktop: dropdown directly beneath the button. */}
                    <div
                        role="menu"
                        data-testid="optimize-menu-desktop"
                        onPointerDown={(event) => event.stopPropagation()}
                        className="hidden md:block absolute right-0 top-full mt-1 z-[5000] w-72 rounded-md border border-white/10 bg-[#0A0A0A] p-1 shadow-xl"
                    >
                        {OPTIMIZE_CHOICES.map((choice) => (
                            <ChoiceRow
                                key={choice.mode}
                                choice={choice}
                                disabled={disabledFor(choice.mode)}
                                disabledReason={carDisabledReason}
                                onSelect={select}
                            />
                        ))}
                        <button
                            type="button"
                            onPointerDown={stopMapInteraction}
                            onClick={(event) => { stopMapInteraction(event); close(); }}
                            className="w-full mt-1 rounded-md px-3 py-2 text-[10px] font-bold text-gray-400 hover:bg-white/10 hover:text-white"
                        >
                            Cancel
                        </button>
                    </div>

                    {/* Mobile: bottom sheet, not tucked into the overflow menu. */}
                    <div
                        data-testid="optimize-menu-mobile"
                        className="md:hidden fixed inset-0 z-[5000] flex items-end"
                        onPointerDown={(event) => { event.stopPropagation(); close(); }}
                    >
                        <div className="absolute inset-0 bg-black/60" />
                        <div
                            role="menu"
                            onPointerDown={(event) => event.stopPropagation()}
                            className="relative w-full rounded-t-2xl border-t border-white/10 bg-[#0A0A0A] p-3 pb-6"
                        >
                            <p className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wide text-gray-500">
                                Optimize route
                            </p>
                            {OPTIMIZE_CHOICES.map((choice) => (
                                <ChoiceRow
                                    key={choice.mode}
                                    choice={choice}
                                    disabled={disabledFor(choice.mode)}
                                    disabledReason={carDisabledReason}
                                    onSelect={select}
                                    compact
                                />
                            ))}
                            <button
                                type="button"
                                onPointerDown={stopMapInteraction}
                                onClick={(event) => { stopMapInteraction(event); close(); }}
                                className="w-full mt-2 rounded-md border border-white/10 px-3 py-3 text-xs font-bold text-gray-300 hover:bg-white/10"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </>
            )}
        </span>
    );
}
