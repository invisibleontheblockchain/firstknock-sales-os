import L from 'leaflet';
import { outcomeColor } from '@/components/logic/outcomeStatus';

// One saved route, built once into a reusable Leaflet layer group.
//
// Routes mode used to rebuild every door, label and line of every visible route
// on each settled zoom/pan, because zooming out always leaves the padded view box.
// At ~40,000 markers that rebuild is seconds of blocked main thread per zoom step.
// Building per route and caching the group lets a zoom become an attach/detach.

export const MAX_DOOR_PINS_PER_ROUTE = 15000;

const decisionStatus = (property) => property?.effective_status || property?.parsed_status || property?.original_status || 'ELIGIBLE';
const hasRecordedDecision = (property) => decisionStatus(property) !== 'ELIGIBLE';

function passesQuickFilter(property, quickFilter) {
    if (quickFilter === 'all') return true;
    if (quickFilter === 'eligible') return property.effective_status === 'ELIGIBLE' || property.effective_status === 'NO_ANSWER';
    if (quickFilter === 'sold') return property.effective_status === 'SOLD' || property.effective_status === 'QUALIFIED';
    if (quickFilter === 'rejected') return property.effective_status === 'HARD_NO';
    return true;
}

/**
 * Everything that changes a route's drawn appearance *except* the dot radius.
 * Radius is applied imperatively so a zoom band change never forces a rebuild.
 */
export function savedRouteStyleKey(style) {
    return [
        style.quickFilter,
        style.showRouteDetails ? 1 : 0,
        style.showRouteLines ? 1 : 0,
        style.decisionFilterActive ? 1 : 0,
        style.pinOpacity,
        style.fillStyle,
        style.pinBorderColor,
        style.pinBorderWidth,
        style.showLabels ? 1 : 0,
        style.labelType,
        style.lineWidth,
        style.lineOpacity,
        style.lineDashArray || '',
    ].join('|');
}

function doorLabelText(property, style) {
    if (style.labelType === 'number') return property.house_number;
    if (style.labelType === 'status') return (property.effective_status || '').slice(0, 1);
    return (property.street_name || '').split(' ')[0];
}

/**
 * @returns {{ group: L.LayerGroup, doorPins: L.CircleMarker[] }}
 * doorPins are returned so the caller can resize them on a zoom band change.
 */
export function buildSavedRouteGroup({ doors, linePoints, centerPoint, number, color, style, dotSize, onSelect }) {
    const group = L.layerGroup();
    const doorPins = [];
    const selectRoute = (event) => {
        L.DomEvent.stopPropagation(event);
        onSelect();
    };

    // Center marker with the route number — hidden while a decision filter is
    // active so only the matching outcome pins remain on the map.
    if (!style.decisionFilterActive && centerPoint) {
        const centerCircle = L.circleMarker(centerPoint, {
            radius: 14, fillColor: 'black', fillOpacity: 0.7, color, weight: 2
        });
        centerCircle.on('click', selectRoute);
        group.addLayer(centerCircle);

        group.addLayer(L.marker(centerPoint, {
            icon: L.divIcon({
                className: '',
                html: `<div style="color:${color};font-weight:900;font-size:10px;text-shadow:0 0 3px #000;pointer-events:none;transform:translate(-50%,-50%);white-space:nowrap">#${number}</div>`,
                iconSize: [0, 0], iconAnchor: [0, 0],
            }),
            interactive: false, keyboard: false,
        }));
    }

    if (style.showRouteDetails) {
        let drawn = 0;
        for (const property of doors) {
            if (drawn >= MAX_DOOR_PINS_PER_ROUTE) break;
            if (!passesQuickFilter(property, style.quickFilter)) continue;
            drawn++;

            const point = [Number(property.lat), Number(property.lng)];
            // Recorded decisions use the same colors as Run Route across every saved route.
            const hasDecision = hasRecordedDecision(property);
            const decisionColor = hasDecision ? outcomeColor(decisionStatus(property)) : null;
            // No separate transparent hitbox: the global 12px canvas tap slop
            // covers tapping without doubling the layer count.
            const circle = L.circleMarker(point, {
                radius: property.effective_status === 'SOLD' ? dotSize + 2 : dotSize,
                fillColor: decisionColor || color,
                fillOpacity: hasDecision ? 1 : (style.pinOpacity || 1),
                color: hasDecision ? (decisionColor === '#FFFFFF' ? '#111827' : '#FFFFFF') : (style.fillStyle === 'outline' ? color : (style.pinBorderColor || '#000')),
                weight: hasDecision ? 2 : (style.fillStyle === 'outline' ? 2 : (style.pinBorderWidth || 1)),
            });
            circle.__sold = property.effective_status === 'SOLD';
            circle.on('click', selectRoute);
            group.addLayer(circle);
            doorPins.push(circle);

            if (style.showLabels) {
                group.addLayer(L.marker(point, {
                    icon: L.divIcon({
                        className: '',
                        html: `<div style="color:#fff;font-weight:bold;font-size:8px;text-shadow:0 0 3px #000;pointer-events:none;transform:translate(-50%,-50%);white-space:nowrap">${doorLabelText(property, style)}</div>`,
                        iconSize: [0, 0], iconAnchor: [0, 0],
                    }),
                    interactive: false, keyboard: false,
                }));
            }
        }
    }

    // Route line, with a wide invisible hit line underneath so it stays easy to
    // tap on mobile.
    if (style.showRouteLines && linePoints.length > 1) {
        const latLngs = linePoints.map(p => [Number(p.lat), Number(p.lng)]);

        const hitLine = L.polyline(latLngs, { color: 'transparent', weight: 26, opacity: 0, interactive: true });
        hitLine.on('click', selectRoute);
        group.addLayer(hitLine);

        const line = L.polyline(latLngs, {
            color,
            weight: style.lineWidth || 3,
            opacity: style.lineOpacity || 0.7,
            dashArray: style.lineDashArray || null,
        });
        line.on('click', selectRoute);
        group.addLayer(line);
    }

    return { group, doorPins };
}