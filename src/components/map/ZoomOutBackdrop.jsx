import { useEffect } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';
import { BACKDROP_LEVELS, backdropLayerOptions } from './zoomOutBackdropConfig.js';

// Zooming out asks for a wider grid at the new level. Until those tiles arrive
// Leaflet can only keep the previous level's tiles under the old view, so the
// rest of the screen showed the dark container: a small rectangle of imagery in
// a dark frame. These layers draw the same basemap from a few low-zoom tiles
// underneath the real ones, so any area the real tiles have not reached yet
// shows slightly softer imagery instead of an empty frame.
//
// Each level covers a zoom band: native zoom 11 for views at zoom 12 and
// closer, native zoom 8 for wider views. One ring of neighbouring tiles keeps a
// wide zoom-out covered beyond the edges of the current view; at these zooms a
// level is only a handful of tiles per region.
let BackdropTileLayer = null;
function backdropLayerClass() {
    if (!BackdropTileLayer) {
        BackdropTileLayer = L.TileLayer.extend({
            _getTiledPixelBounds(center) {
                const bounds = L.TileLayer.prototype._getTiledPixelBounds.call(this, center);
                // Pixel bounds are in the tile zoom's own space, so one ring is one tile size.
                const pad = L.point(this.options.tileSize, this.options.tileSize).multiplyBy(this.options.ringTiles || 0);
                return L.bounds(bounds.min.subtract(pad), bounds.max.add(pad));
            },
        });
    }
    return BackdropTileLayer;
}

/**
 * Renders the low-zoom backdrop for one basemap URL. Mount it once the real
 * basemap has loaded its first view so it never competes with that download.
 */
export default function ZoomOutBackdrop({ url }) {
    const map = useMap();
    useEffect(() => {
        if (!url) return undefined;
        const Layer = backdropLayerClass();
        const phone = Boolean(L.Browser.mobile || L.Browser.touch);
        const layers = BACKDROP_LEVELS.map((level) => new Layer(url, backdropLayerOptions(level, { phone })));
        layers.forEach((layer) => layer.addTo(map));
        return () => layers.forEach((layer) => layer.remove());
    }, [map, url]);
    return null;
}
