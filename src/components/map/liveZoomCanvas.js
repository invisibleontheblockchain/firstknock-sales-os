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

// Dashed lines: a dash pattern is fixed in screen pixels and restarts where
// Leaflet clips a line to the screen, so redrawing mid-zoom made the dashes
// race along route lines ("accelerating"). Mid-gesture, dashes scale with the
// zoom since the gesture began and lines are drawn unclipped, so every dash
// stays on the same spot of the ground and moves with the dots. Both are
// restored when the zoom ends.
//
// Offscreen bounds for paths left out of a mid-zoom frame: they fail every
// visibility test (Canvas._draw, CircleMarker._empty, the stop-number pass).
const HIDDEN = Symbol('liveZoomHidden');
const RESTING = Symbol('liveZoomRestingLineStyle');
const OFFSCREEN_MIN = -1e9;

export const LIVE_ZOOM_FRAME_BUDGET_MS = 12;

/** A dash pattern scaled by `scale` (null for a solid line). */
export function scaledDashArray(dashArray, scale) {
    if (!Array.isArray(dashArray) || !dashArray.length || !(scale > 0)) return dashArray;
    return dashArray.map(value => value * scale);
}

// Mid-gesture line style: scaled dashes, no clipping. The resting style is
// kept on the layer so zoomend (or removal) can put it back exactly.
function applyGestureLineStyle(layer, scale) {
    if (!layer._latlngs) return;
    if (!layer[RESTING]) layer[RESTING] = { dash: layer.options._dashArray, noClip: layer.options.noClip };
    layer.options.noClip = true;
    layer.options._dashArray = scaledDashArray(layer[RESTING].dash, scale);
}

function restoreLineStyle(layer) {
    const resting = layer[RESTING];
    if (!resting) return;
    layer.options._dashArray = resting.dash;
    layer.options.noClip = resting.noClip;
    delete layer[RESTING];
}

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
    const Live = Base.extend({
        _onZoom() {
            // The zoom the canvas was last fully drawn at: dashes scale from here.
            if (this._liveGestureZoom === undefined) this._liveGestureZoom = this._zoom;
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
            const dashScale = map.getZoomScale(map.getZoom(), this._liveGestureZoom ?? map.getZoom());
            for (const id in this._layers) {
                const layer = this._layers[id];
                if (pathNearView(layer, view)) {
                    if (layer[HIDDEN]) delete layer[HIDDEN];
                    applyGestureLineStyle(layer, dashScale);
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
            for (const id in this._layers) {
                delete this._layers[id][HIDDEN];
                restoreLineStyle(this._layers[id]);
            }
            this._liveGestureZoom = undefined;
            Base.prototype._onZoomEnd.call(this);
        },

        _removePath(layer) {
            restoreLineStyle(layer);
            delete layer[HIDDEN];
            return Base.prototype._removePath.call(this, layer);
        },

        _updateStyle(layer) {
            // A style change mid-gesture (setStyle) recomputes the resting dashes.
            const resting = layer[RESTING];
            if (resting) restoreLineStyle(layer);
            Base.prototype._updateStyle.call(this, layer);
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
