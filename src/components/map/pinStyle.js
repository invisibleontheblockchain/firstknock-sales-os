// Territory pin styling.
//
// This derivation used to live inline inside the pin layer's rebuild loop, so it
// re-ran for every visible pin on every pan, zoom and settings change — a Date
// allocation, a throwaway array literal and several lookups per pin, up to
// 12,000 times per rebuild, from inputs that do not change while panning.
//
// It is extracted here so the pin layer can cache a style per property and reuse
// it until one of the *style inputs* actually changes. The expressions are the
// ones the layer used before: colors, radii, opacity, borders and confidence
// rings are unchanged.

import { CONFIDENCE_COLORS } from '@/components/map/ConfidenceLegend';

// Allocated once instead of once per pin.
const UNVISITED_STATUSES = new Set(['ELIGIBLE', 'NO_ANSWER', 'OTHER']);
const ORIGINAL_STATUS_OVERRIDES = new Set(['SOLD', 'RECENT_OFF_MARKET', 'PENDING']);

/** Stable identity for a rendered pin, used as the marker-store key. */
export function pinKey(property) {
    return String(
        property?.address_hash
        || property?.id
        || `${property?.lat},${property?.lng}`
    );
}

/**
 * Cache key for everything outside the property itself that affects styling.
 * When this changes, every cached style is dropped and re-derived.
 */
export function pinStyleContextKey(context) {
    return [
        context.colorScheme,
        context.pinOpacity,
        context.pinBorderColor,
        context.pinBorderWidth,
        context.fillStyle,
        context.highlightRecentlySold ? 1 : 0,
        context.denseView ? 1 : 0,
        context.dotSize,
        context.oneMonthAgo?.getTime?.() ?? '',
        // Color scheme identity alone is not enough: the scheme map is swapped by
        // reference, so the resolved palette is part of the key.
        JSON.stringify(context.statusColors || {})
    ].join('|');
}

/**
 * Marker options for one property, plus optional confidence-ring options and a
 * cheap comparison key so a surviving marker is only restyled when it changed.
 */
export function buildPinStyle(property, context) {
    const {
        statusColors, colorScheme, pinOpacity, pinBorderColor, pinBorderWidth,
        fillStyle, highlightRecentlySold, oneMonthAgo, denseView, dotSize
    } = context;

    let isRecentlySold = false;
    if (highlightRecentlySold && property.sold_date) {
        isRecentlySold = new Date(property.sold_date) > oneMonthAgo;
    }
    const isUnvisited = UNVISITED_STATUSES.has(property.effective_status);
    let effectiveColorStatus = property.effective_status;
    if (
        property.effective_status === 'ELIGIBLE'
        && property.original_status
        && ORIGINAL_STATUS_OVERRIDES.has(property.original_status)
    ) {
        effectiveColorStatus = property.original_status;
    }

    // Confidence-tier coloring when the 'confidence' color scheme is active.
    const useConfidenceColors = colorScheme === 'confidence';
    let fillColor;
    if (isRecentlySold) {
        fillColor = '#FF00FF';
    } else if (useConfidenceColors && property.sale_confidence && CONFIDENCE_COLORS[property.sale_confidence]) {
        fillColor = CONFIDENCE_COLORS[property.sale_confidence];
    } else {
        fillColor = statusColors[effectiveColorStatus] || statusColors.OTHER;
    }

    // Callback pins render slightly smaller than other outcome pins.
    const isCallback = effectiveColorStatus === 'CALLBACK';
    const marker = {
        radius: isRecentlySold ? dotSize + 4 : (isCallback ? dotSize * 0.9 : dotSize),
        fillColor,
        fillOpacity: isRecentlySold ? 1 : (pinOpacity || 1),
        color: isRecentlySold ? '#FFFFFF' : (fillStyle === 'outline' ? fillColor : (pinBorderColor || '#000')),
        weight: isRecentlySold ? 2 : (fillStyle === 'outline' ? 2 : pinBorderWidth)
    };

    // Confidence ring: subtle outer glow for verified/high leads in any color
    // scheme. Skipped on dense views — a second layer per pin is what tips large
    // territories into unusable pan/zoom lag.
    const conf = property.sale_confidence;
    const showConfRing = !denseView && !useConfidenceColors && !isRecentlySold && !isUnvisited
        && conf && (conf === 'high' || conf === 'verified');
    const ring = showConfRing
        ? {
            radius: dotSize + 3,
            fillColor: 'transparent',
            fillOpacity: 0,
            color: CONFIDENCE_COLORS[conf],
            weight: 1.5,
            opacity: 0.6
        }
        : null;

    return {
        marker,
        ring,
        styleKey: [
            marker.radius, marker.fillColor, marker.fillOpacity, marker.color, marker.weight,
            ring ? ring.color : '', ring ? ring.radius : ''
        ].join('|')
    };
}