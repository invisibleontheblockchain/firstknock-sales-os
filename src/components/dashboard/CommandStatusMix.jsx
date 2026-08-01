import React from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip as RechartsTooltip } from 'recharts';
import { PieChart as PieChartIcon } from 'lucide-react';

// Green is reserved for confirmed sales only. Every other outcome gets a
// distinct non-green hue so no two slices share a color.
const SOLD_COLOR = '#2EEB57';
const OUTCOME_COLORS = {
    SOLD: SOLD_COLOR,
    QUALIFIED: '#3b82f6',
    CALLBACK: '#eab308',
    NO_ANSWER: '#64748b',
    DM_NOT_HOME: '#8b5cf6',
    NOT_MOVED_IN: '#06b6d4',
    HARD_NO: '#ef4444',
    ELIGIBLE: '#f97316',
};
const FALLBACK_COLORS = ['#ec4899', '#a3a3a3', '#f59e0b', '#0ea5e9', '#d946ef', '#78716c'];

function buildColorMap(data) {
    const used = new Set();
    const map = {};
    let fallbackIndex = 0;
    data.forEach((d) => {
        const key = String(d.name || '').toUpperCase();
        let color = OUTCOME_COLORS[key];
        if (!color || used.has(color)) {
            do {
                color = FALLBACK_COLORS[fallbackIndex % FALLBACK_COLORS.length];
                fallbackIndex += 1;
            } while (used.has(color) && fallbackIndex < FALLBACK_COLORS.length * 2);
        }
        used.add(color);
        map[d.name] = color;
    });
    return map;
}

function ChartTooltip({ active, payload }) {
    if (!active || !payload?.length) return null;
    return (
        <div className="rounded-lg border border-white/10 bg-[#0A0A0A] px-2.5 py-1.5 text-[10px] font-bold text-white shadow-2xl">
            {payload[0].name}: <span className="text-[#39FF4A]">{payload[0].value}</span>
        </div>
    );
}

export default function CommandStatusMix({ data, total }) {
    const colorMap = React.useMemo(() => buildColorMap(data), [data]);

    return (
        <div className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-center gap-2">
                <PieChartIcon className="h-4 w-4 text-[#39FF4A]" />
                <span className="text-[10px] font-black uppercase tracking-[0.16em] text-white lg:text-[11px]">Outcome Mix</span>
                <span className="ml-auto rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[9px] font-bold tabular-nums text-white/60">
                    {total.toLocaleString()} knocks
                </span>
            </div>

            <div className="relative mt-3 min-h-[170px] flex-1">
                {data.length === 0 ? (
                    <div className="absolute inset-0 flex items-center justify-center text-[11px] font-bold text-white/35">
                        No outcomes logged
                    </div>
                ) : (
                    <>
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                                <Pie
                                    data={data}
                                    cx="50%"
                                    cy="50%"
                                    innerRadius={0}
                                    outerRadius={78}
                                    paddingAngle={1}
                                    dataKey="value"
                                    stroke="none"
                                >
                                    {data.map((d) => <Cell key={d.name} fill={colorMap[d.name]} />)}
                                </Pie>
                                <RechartsTooltip content={<ChartTooltip />} />
                            </PieChart>
                        </ResponsiveContainer>
                    </>
                )}
            </div>

            {data.length > 0 && (
                <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
                    {data.slice(0, 6).map((d) => (
                        <div key={d.name} className="flex items-center gap-1.5 text-[9px] font-bold text-white/50 lg:text-[10px]">
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colorMap[d.name] }} />
                            <span className="truncate capitalize">{d.name.toLowerCase()}</span>
                            <span className="ml-auto font-mono tabular-nums text-white/80">{d.value}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}