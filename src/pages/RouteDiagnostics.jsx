import React, { useEffect, useMemo, useState } from 'react';
import { optimizeRouteByStreetSweep } from '@/components/logic/routeOptimizer';
import { describeRoute, findPassedStops, TAIL_LEG_WINDOW } from '@/components/diagnostics/routeComparisonMetrics';
import RouteComparisonMap from '@/components/diagnostics/RouteComparisonMap';

/**
 * Development-only route comparison. Renders the original optimizer output, the
 * previous production output, an independent benchmark, and the current
 * optimizer output over the same 58 verified Mesquite doors, scored on the baked
 * driving matrix rather than straight-line distance.
 */
const ROUTE_STYLES = [
    { id: 'original', label: 'Original optimizer', color: '#F87171', defaultVisible: false },
    { id: 'production', label: 'Previous production', color: '#FFD700', defaultVisible: true },
    { id: 'benchmark', label: 'Independent benchmark', color: '#60A5FA', defaultVisible: false },
    { id: 'improved', label: 'Current optimizer', color: '#39FF4A', defaultVisible: true }
];

export default function RouteDiagnostics() {
    const [fixture, setFixture] = useState(null);
    const [visibleIds, setVisibleIds] = useState(
        () => new Set(ROUTE_STYLES.filter(style => style.defaultVisible).map(({ id }) => id))
    );

    useEffect(() => {
        if (!import.meta.env.DEV) return;
        import('../../test/fixtures/mesquite-route-58.json')
            .then(module => setFixture(module.default || module));
    }, []);

    const analysis = useMemo(() => {
        if (!fixture) return null;
        const indexByHash = new Map(fixture.properties.map((property, index) => [property.address_hash, index]));
        const roadMiles = (first, second) => (
            fixture.road.distances[indexByHash.get(first.address_hash)][indexByHash.get(second.address_hash)]
        );
        const roadMinutes = (first, second) => (
            fixture.road.durationsMinutes[indexByHash.get(first.address_hash)][indexByHash.get(second.address_hash)]
        );
        const byHash = hashes => hashes.map(hash => fixture.properties.find(p => p.address_hash === hash));
        const improved = optimizeRouteByStreetSweep(fixture.properties, null, null, { distanceBetween: roadMiles });
        const orders = { ...fixture.orders };

        const routes = ROUTE_STYLES.map(style => ({
            ...style,
            visible: visibleIds.has(style.id),
            described: describeRoute(
                style.id === 'improved' ? improved : byHash(orders[style.id]),
                { roadMiles, roadMinutes }
            )
        }));
        return {
            routes,
            roadMiles,
            center: [fixture.properties[0].lat, fixture.properties[0].lng]
        };
    }, [fixture, visibleIds]);

    if (!import.meta.env.DEV) {
        return (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-white/60">
                Route diagnostics are available in development builds only.
            </div>
        );
    }

    if (!analysis) {
        return <div className="flex h-full items-center justify-center text-sm text-white/60">Loading fixture…</div>;
    }

    const improvedRoute = analysis.routes.find(route => route.id === 'improved');
    const passed = findPassedStops(improvedRoute.described, analysis.roadMiles);

    return (
        <div className="flex h-full flex-col overflow-y-auto bg-black text-white">
            <div className="flex flex-wrap items-center gap-2 border-b border-white/10 p-3">
                {analysis.routes.map(route => (
                    <button
                        key={route.id}
                        type="button"
                        onClick={() => setVisibleIds((current) => {
                            const next = new Set(current);
                            if (next.has(route.id)) next.delete(route.id);
                            else next.add(route.id);
                            return next;
                        })}
                        className={`rounded-full border px-3 py-1.5 text-[11px] font-bold transition ${route.visible ? 'bg-white/10' : 'opacity-40'}`}
                        style={{ borderColor: route.color, color: route.color }}
                    >
                        {route.label} · {route.described.roadMiles.toFixed(2)} mi
                    </button>
                ))}
                <span className="ml-auto text-[10px] text-white/40">
                    Red legs = final {TAIL_LEG_WINDOW}. Thick dashed = five longest road legs. Lines are straight segments; road cost is in the table.
                </span>
            </div>

            <div className="h-[55vh] min-h-[320px] w-full">
                <RouteComparisonMap routes={analysis.routes} center={analysis.center} />
            </div>

            <div className="overflow-x-auto p-3">
                <table className="w-full min-w-[720px] text-left text-[11px]">
                    <thead className="text-white/50">
                        <tr>
                            {['Route', 'Road mi', 'Drive min', 'Straight mi', `Final ${TAIL_LEG_WINDOW} mi`, 'Longest leg', 'Transitions', 'Reentries', 'Crossings'].map(head => (
                                <th key={head} className="py-1.5 pr-3 font-bold">{head}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="font-mono">
                        {analysis.routes.map(({ id, label, color, described }) => (
                            <tr key={id} className="border-t border-white/5">
                                <td className="py-1.5 pr-3 font-sans font-bold" style={{ color }}>{label}</td>
                                <td className="pr-3">{described.roadMiles.toFixed(3)}</td>
                                <td className="pr-3">{described.roadMinutes.toFixed(1)}</td>
                                <td className="pr-3">{described.straightMiles.toFixed(3)}</td>
                                <td className="pr-3">{described.tailMiles.toFixed(3)}</td>
                                <td className="pr-3">{described.longestLegMiles.toFixed(3)}</td>
                                <td className="pr-3">{described.transitions}</td>
                                <td className="pr-3">{described.reentries.length}</td>
                                <td className="pr-3">{described.crossings.length}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                <h2 className="mt-5 text-[11px] font-bold uppercase tracking-wide text-[#39FF4A]">
                    Current optimizer — apparent crossings
                </h2>
                <ul className="mt-1.5 space-y-1 font-mono text-[11px] text-white/70">
                    {improvedRoute.described.crossings.map(({ first, second }) => {
                        const legs = improvedRoute.described.legs;
                        return (
                            <li key={`${first}-${second}`}>
                                {`stops ${first + 1}→${first + 2} × ${second + 1}→${second + 2} · `}
                                {`${legs[first].miles.toFixed(3)} mi (ratio ${legs[first].detourRatio.toFixed(2)}) × `}
                                {`${legs[second].miles.toFixed(3)} mi (ratio ${legs[second].detourRatio.toFixed(2)})`}
                            </li>
                        );
                    })}
                    {improvedRoute.described.crossings.length === 0 && <li>none</li>}
                </ul>

                <h2 className="mt-5 text-[11px] font-bold uppercase tracking-wide text-[#39FF4A]">
                    Stops driven past and visited later ({passed.length})
                </h2>
                <ul className="mt-1.5 space-y-1 font-mono text-[11px] text-white/70">
                    {passed.slice(0, 10).map(({ atIndex, at, later }) => (
                        <li key={`${atIndex}-${later.address_hash}`}>
                            {`stop ${atIndex + 1} ${at.house_number} ${at.street_name} passes ${later.house_number} ${later.street_name}`}
                        </li>
                    ))}
                    {passed.length === 0 && <li>none</li>}
                </ul>
            </div>
        </div>
    );
}