import React from 'react';

export default function CommandKpiGrid({ items }) {
    return (
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4 lg:gap-4">
            {items.map(k => (
                <div
                    key={k.label}
                    className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-3.5 lg:p-5"
                >
                    <div
                        className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full blur-2xl opacity-60 transition-opacity group-hover:opacity-100"
                        style={{ background: k.color }}
                    />
                    <div className="relative z-10 flex items-start justify-between gap-2">
                        <span className="text-[9px] font-black uppercase tracking-[0.14em] text-white/45 lg:text-[10px]">
                            {k.label}
                        </span>
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-black/50 lg:h-9 lg:w-9">
                            <k.icon className="h-3.5 w-3.5 lg:h-4 lg:w-4" style={{ color: k.color }} />
                        </div>
                    </div>
                    <p className="relative z-10 mt-2 font-mono text-2xl font-black tabular-nums tracking-tight text-white lg:text-3xl">
                        {k.value}
                    </p>
                    {k.sub && (
                        <p className="relative z-10 mt-0.5 text-[9px] font-bold text-white/35 lg:text-[10px]">{k.sub}</p>
                    )}
                </div>
            ))}
        </div>
    );
}