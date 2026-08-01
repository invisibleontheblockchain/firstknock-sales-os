import React from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip } from 'react-leaflet';

/**
 * Development-only overlay of several candidate orderings of the same doors.
 * Lines are straight coordinate segments — the baked fixture carries a driving
 * matrix but no road geometry — so crossings are labelled as apparent until the
 * road cost of the crossing legs is inspected in the table beside the map.
 */
export default function RouteComparisonMap({ routes, center }) {
    const visible = routes.filter(route => route.visible);

    return (
        <MapContainer center={center} zoom={14} className="h-full w-full" scrollWheelZoom>
            <TileLayer
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                attribution="&copy; OpenStreetMap contributors &copy; CARTO"
            />
            {visible.map(route => (
                <React.Fragment key={route.id}>
                    {route.described.legs.map(leg => (
                        <Polyline
                            key={`${route.id}-${leg.index}`}
                            positions={[[leg.from.lat, leg.from.lng], [leg.to.lat, leg.to.lng]]}
                            pathOptions={{
                                color: leg.isTail ? '#FF6B6B' : route.color,
                                weight: route.described.longestLegIndexes.has(leg.index) ? 6 : 3,
                                opacity: leg.isTail ? 0.95 : 0.75,
                                dashArray: route.described.longestLegIndexes.has(leg.index) ? '10 6' : null
                            }}
                        >
                            <Tooltip sticky>
                                {`#${leg.index + 1} → ${leg.index + 2} · ${leg.miles.toFixed(3)} mi road · ${leg.straightMiles.toFixed(3)} mi straight · ratio ${leg.detourRatio.toFixed(2)}${leg.isTail ? ' · final stretch' : ''}`}
                            </Tooltip>
                        </Polyline>
                    ))}
                    {route.described.order.map((property, index) => (
                        <CircleMarker
                            key={`${route.id}-stop-${property.address_hash}`}
                            center={[property.lat, property.lng]}
                            radius={index === 0 ? 8 : 5}
                            pathOptions={{
                                color: route.color,
                                fillColor: index === 0 ? '#FFFFFF' : route.color,
                                fillOpacity: 1,
                                weight: 2
                            }}
                        >
                            <Tooltip>
                                {`${index + 1}. ${property.house_number} ${property.street_name}`}
                            </Tooltip>
                        </CircleMarker>
                    ))}
                </React.Fragment>
            ))}
        </MapContainer>
    );
}