// Leaflet only re-projects and redraws canvas paths when a zoom ends; while a
// pinch is in progress it stretches the canvas bitmap with a CSS scale. Route
// dots, stop numbers and lines therefore grew huge and blurry mid-pinch (the
// owner's iPhone) and snapped back on release. This renderer redraws at the
// live zoom instead, at most once per animation frame, so dots and numbers
// keep their size and stay sharp while the map zooms.
//
// Only paths near the screen are re-projected and drawn mid-zoom. The rest
// keep Leaflet's own projection and are hidden from the frame until the zoom
// ends, when Leaflet re-projects and redraws everything as before. If a frame
// costs too much (a phone with thousands of stops on screen), live redraws
// back off so the gesture itself stays smooth.
//
// Dashed lines (route lines) are drawn so their dashes stay on the ground:
//  - unclipped and unsimplified, so the dash pattern always starts at the
//    line's first point (Leaflet restarts it wherever it clips a line to the
//    screen, which moves on every frame and on every pinch start and end);
//  - projected without rounding (Leaflet rounds each vertex to a whole pixel;
//    along a long route those errors add up to several pixels, enough to
//    shift every dash from one frame to the next);
//  - with dash lengths that scale with the map, like paint on the road. After
//    a zoom the dash size is re-gridded by a factor of 2 only once it has
//    drifted more than half a zoom level, keeping the pattern in place at the
//    screen centre, so small pinches in and out change nothing at all.
// The owner saw the dashes "accelerating" along route lines while zooming.

// Offscreen bounds for paths left out of a mid-zoom frame: they fail every
// visibility test (Canvas._draw, CircleMarker._empty, the stop-number pass).
const HIDDEN = Symbol('liveZoomHidden');
const DASHED = Symbol('liveZoomDashedLine');
const DASH_OFFSET = Symbol('liveZoomDashOffset');
const OFFSCREEN_MIN = -1e9;

export const LIVE_ZOOM_FRAME_BUDGET_MS = 12;
export const DASH_REGRID_ZOOM = 0.5;

/** A dash pattern scaled by `scale` (unchanged for a solid line). */
export function scaledDashArray(dashArray, scale) {
    if (!Array.isArray(dashArray) || !dashArray.length || !(scale > 0)) return dashArray;
    return dashArray.map(value => value * scale);
}

/** How much longer dashes are drawn at `zoom` than at the renderer's dash zoom: their length on the ground stays fixed. */
export function dashScaleAt(zoom, dashZoom) {
    return 2 ** (zoom - dashZoom);
}

/** The dash zoom after a zoom ends: re-gridded by whole levels once the dashes drifted more than half a level. */
export function regriddedDashZoom(zoom, dashZoom, limit = DASH_REGRID_ZOOM) {
    const drift = zoom - dashZoom;
    return Math.abs(drift) > limit ? dashZoom + Math.round(drift) : dashZoom;
}

/**
 * The dash offset (px) that keeps the pattern's phase at `along` px from the
 * line's start unchanged when its period changes from oldPeriod to newPeriod.
 */
export function pivotDashOffset(along, oldOffset, oldPeriod, newPeriod) {
    const turns = (along + oldOffset) / oldPeriod;
    const phase = turns - Math.floor(turns);
    const offset = phase * newPeriod - along;
    return ((offset % newPeriod) + newPeriod) % newPeriod;
}

/** Distance along a ring of points (px) to the point of the ring nearest `p`. */
export function alongNearestPoint(ring, p) {
    let best = Infinity, bestAlong = 0, along = 0;
    for (let i = 0; i + 1 < ring.length; i++) {
        const a = ring[i], b = ring[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const length = Math.hypot(dx, dy);
        const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (length * length))) : 0;
        const distance = Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
        if (distance < best) { best = distance; bestAlong = along + length * t; }
        along += length;
    }
    return bestAlong;
}

const isDashedLine = layer => Boolean(layer?._latlngs) && Array.isArray(layer.options?._dashArray) && layer.options._dashArray.length > 0;

/** Whether a path is on or near the given LatLngBounds. */
export function pathNearView(layer, view) {
    // Lines and polygons: their bounds. Dots: their point.
    if (layer._latlngs && typeof layer.getBounds === 'function') {
        const bounds = layer.getBounds();
        return Boolean(bounds?.isValid?.()) && view.intersects(bounds);
    }
    if (typeof layer.getLatLng === 'function') {
        const point = layer.getLatLng();
        return Boolean(point) && view.contains(point);
    }
    return true;
}

/**
 * Delay before the next live redraw, from the last frame's cost: none while
 * frames are cheap, then proportionally longer so redraws use at most about
 * half of the time.
 */
export function liveZoomBackoffMs(lastCostMs, budgetMs = LIVE_ZOOM_FRAME_BUDGET_MS) {
    if (!(lastCostMs > budgetMs)) return 0;
    return Math.min(250, Math.round(lastCostMs * 2));
}

const classes = new WeakMap();

/** A Canvas renderer class (extending `Base`, default L.Canvas) that redraws mid-zoom. */
export function liveZoomCanvasClass(L, Base = L.Canvas) {
    let byBase = classes.get(L);
    if (!byBase) classes.set(L, (byBase = new Map()));
    if (byBase.has(Base)) return byBase.get(Base);
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // Leaflet's Polyline._projectLatlngs without the rounding to whole pixels.
    function unroundedProjectLatlngs(latlngs, result, projectedBounds) {
        const map = this._map;
        if (latlngs[0] instanceof L.LatLng) {
            const origin = map.getPixelOrigin();
            const ring = latlngs.map(latlng => map.project(latlng)._subtract(origin));
            ring.forEach(point => projectedBounds.extend(point));
            result.push(ring);
        } else {
            latlngs.forEach(inner => this._projectLatlngs(inner, result, projectedBounds));
        }
    }

    // Dashed lines: unclipped, unsimplified, unrounded (see the top of the file).
    // Undone when the line stops being dashed or leaves this renderer.
    function prepareLine(layer) {
        if (isDashedLine(layer)) {
            if (layer[DASHED]) return;
            layer[DASHED] = { noClip: layer.options.noClip, smoothFactor: layer.options.smoothFactor,
                ownProject: Object.prototype.hasOwnProperty.call(layer, '_projectLatlngs') ? layer._projectLatlngs : null };
            layer.options.noClip = true;
            layer.options.smoothFactor = 0;
            layer._projectLatlngs = unroundedProjectLatlngs;
        } else if (layer[DASHED]) {
            releaseLine(layer);
        }
    }
    function releaseLine(layer) {
        const original = layer[DASHED];
        if (!original) return;
        layer.options.noClip = original.noClip;
        layer.options.smoothFactor = original.smoothFactor;
        if (original.ownProject) layer._projectLatlngs = original.ownProject;
        else delete layer._projectLatlngs;
        delete layer[DASHED];
        delete layer[DASH_OFFSET];
    }

    const Live = Base.extend({
        onAdd(map) {
            Base.prototype.onAdd.call(this, map);
            if (this._dashZoom === undefined) this._dashZoom = this._map.getZoom();
        },

        _initPath(layer) {
            Base.prototype._initPath.call(this, layer);
            prepareLine(layer);
        },

        _updateStyle(layer) {
            Base.prototype._updateStyle.call(this, layer);
            const wasDashed = Boolean(layer[DASHED]);
            prepareLine(layer);
            // Became dashed (or solid): re-project with the matching rules.
            if (wasDashed !== Boolean(layer[DASHED]) && layer._map) { layer._project(); layer._update(); }
        },

        _removePath(layer) {
            releaseLine(layer);
            delete layer[HIDDEN];
            return Base.prototype._removePath.call(this, layer);
        },

        // The dash pattern a dashed line is drawn with now: { dashArray, offset } in px.
        _dashState(layer) {
            if (!layer[DASHED] || !isDashedLine(layer) || !this._map) return null;
            const scale = dashScaleAt(this._map.getZoom(), this._dashZoom ?? this._map.getZoom());
            return { dashArray: scaledDashArray(layer.options._dashArray, scale), offset: (layer[DASH_OFFSET] || 0) * scale };
        },

        _fillStroke(ctx, layer) {
            if (!layer[DASHED] || !isDashedLine(layer) || !this._map) {
                Base.prototype._fillStroke.call(this, ctx, layer);
                return;
            }
            if (this._dashZoom === undefined) this._dashZoom = this._map.getZoom();
            const scale = dashScaleAt(this._map.getZoom(), this._dashZoom);
            const resting = layer.options._dashArray;
            layer.options._dashArray = scaledDashArray(resting, scale);
            ctx.lineDashOffset = (layer[DASH_OFFSET] || 0) * scale;
            try {
                Base.prototype._fillStroke.call(this, ctx, layer);
            } finally {
                layer.options._dashArray = resting;
                ctx.lineDashOffset = 0;
            }
        },

        _onZoom() {
            Base.prototype._onZoom.call(this);
            if (this._liveZoomFrame || this._liveZoomWait) return;
            this._liveZoomFrame = L.Util.requestAnimFrame(this._redrawAtLiveZoom, this);
        },

        _redrawAtLiveZoom() {
            this._liveZoomFrame = null;
            const map = this._map;
            // A CSS zoom animation (buttons, double tap) owns the canvas until it lands.
            if (!map || map._animatingZoom || !this._ctx) return;
            const started = now();
            L.Renderer.prototype._update.call(this);
            const b = this._bounds;
            const size = b.getSize();
            const m = L.Browser.retina ? 2 : 1;
            L.DomUtil.setPosition(this._container, b.min);
            if (this._container.width !== m * size.x || this._container.height !== m * size.y) {
                this._container.width = m * size.x;
                this._container.height = m * size.y;
                this._container.style.width = `${size.x}px`;
                this._container.style.height = `${size.y}px`;
            }
            this._ctx.setTransform(m, 0, 0, m, 0, 0);
            this._ctx.translate(-b.min.x, -b.min.y);

            const view = map.getBounds().pad(Math.max(0.1, this.options.padding || 0));
            for (const id in this._layers) {
                const layer = this._layers[id];
                if (pathNearView(layer, view)) {
                    if (layer[HIDDEN]) delete layer[HIDDEN];
                    layer._project();
                    layer._update();
                } else {
                    layer[HIDDEN] = true;
                    layer._pxBounds = L.bounds([OFFSCREEN_MIN, OFFSCREEN_MIN], [OFFSCREEN_MIN + 1, OFFSCREEN_MIN + 1]);
                }
            }
            this._redrawBounds = L.bounds(b.min, b.max);
            this._redraw();
            const cost = now() - started;
            const wait = liveZoomBackoffMs(cost);
            if (wait) {
                this._liveZoomWait = setTimeout(() => { this._liveZoomWait = null; }, wait);
            }
        },

        _onZoomEnd() {
            if (this._liveZoomFrame) L.Util.cancelAnimFrame(this._liveZoomFrame);
            this._liveZoomFrame = null;
            if (this._liveZoomWait) clearTimeout(this._liveZoomWait);
            this._liveZoomWait = null;
            // Leaflet re-projects every path here (hidden ones included), then
            // its moveend redraws the whole canvas, exactly as before.
            for (const id in this._layers) delete this._layers[id][HIDDEN];
            Base.prototype._onZoomEnd.call(this);
            this._regridDashes();
        },

        // Dashes drifted more than half a zoom level from their resting size:
        // halve or double them, keeping the pattern in place at the screen centre.
        _regridDashes() {
            const map = this._map;
            if (!map || this._dashZoom === undefined) return;
            const zoom = map.getZoom();
            const next = regriddedDashZoom(zoom, this._dashZoom);
            if (next === this._dashZoom) return;
            const oldScale = dashScaleAt(zoom, this._dashZoom);
            const newScale = dashScaleAt(zoom, next);
            const centre = map.project(map.getCenter())._subtract(map.getPixelOrigin());
            for (const id in this._layers) {
                const layer = this._layers[id];
                if (!layer[DASHED] || !isDashedLine(layer) || !layer._rings?.length) continue;
                const period = layer.options._dashArray.reduce((sum, value) => sum + value, 0);
                const along = alongNearestPoint(layer._rings[0], centre);
                const offset = pivotDashOffset(along, (layer[DASH_OFFSET] || 0) * oldScale, period * oldScale, period * newScale);
                layer[DASH_OFFSET] = offset / newScale;
            }
            this._dashZoom = next;
        },

        onRemove(map) {
            if (this._liveZoomFrame) L.Util.cancelAnimFrame(this._liveZoomFrame);
            if (this._liveZoomWait) clearTimeout(this._liveZoomWait);
            this._liveZoomFrame = null;
            this._liveZoomWait = null;
            return Base.prototype.onRemove.call(this, map);
        },
    });
    byBase.set(Base, Live);
    return Live;
}

/** Drop-in for L.canvas(options) that keeps paths sharp and sized mid-zoom. */
export function liveZoomCanvas(L, options) {
    const Live = liveZoomCanvasClass(L);
    return new Live(options);
}
