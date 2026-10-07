// Leaflet 1.9 Canvas draws paths in one pass. Draw labels in a second pass so
// later dots never cover earlier numbers. Visual bounds include the text;
// CircleMarker's original hit testing still uses only the circle/touch radius.
const classes = new WeakMap();

export function labelGeometry(point, label, measure) {
    if (!label || label.text === null || label.text === undefined || label.text === '') return null;
    const text = String(label.text);
    const size = label.size || 10;
    const font = `${label.weight || 600} ${size}px Arial, sans-serif`;
    const width = measure(text, font);
    const x = point.x;
    const y = point.y + (label.offsetY || 0);
    const bottom = label.centered ? y + size / 2 : y;
    return { text, font, x, bottom, min: [x - width / 2 - 5, bottom - size - 5], max: [x + width / 2 + 5, bottom + 5] };
}

export function createLabelCanvas(L) {
    if (!classes.has(L)) {
        const Renderer = L.Canvas.extend({
            measureLabel(text, font) {
                this._ctx.save();
                this._ctx.font = font;
                const width = this._ctx.measureText(text).width;
                this._ctx.restore();
                return width;
            },
            _draw() {
                L.Canvas.prototype._draw.call(this);
                const ctx = this._ctx;
                const bounds = this._redrawBounds;
                ctx.save();
                if (bounds) {
                    const size = bounds.getSize();
                    ctx.beginPath();
                    ctx.rect(bounds.min.x, bounds.min.y, size.x, size.y);
                    ctx.clip();
                }
                ctx.globalAlpha = 1;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.shadowColor = '#000';
                ctx.shadowBlur = 3;
                ctx.shadowOffsetY = 1;
                for (let order = this._drawFirst; order; order = order.next) {
                    const layer = order.layer;
                    if (!layer.options.stopLabel || layer._empty() || (bounds && !layer._pxBounds.intersects(bounds))) continue;
                    const label = layer._stopLabelGeometry;
                    if (!label) continue;
                    ctx.font = label.font;
                    ctx.fillStyle = layer.options.stopLabel.color || '#fff';
                    ctx.fillText(label.text, label.x, label.bottom);
                }
                ctx.restore();
            },
        });
        const Marker = L.CircleMarker.extend({
            _containsPoint(point) {
                return L.CircleMarker.prototype._containsPoint.call(this, point)
                    || point.distanceTo(this._point) <= (this.options.touchRadius || 0);
            },
            _updateBounds() {
                L.CircleMarker.prototype._updateBounds.call(this);
                const touch = this.options.touchRadius || 0;
                if (touch) this._pxBounds.extend(this._point.subtract([touch, touch])).extend(this._point.add([touch, touch]));
                const label = labelGeometry(this._point, this.options.stopLabel, (text, font) => this._renderer.measureLabel(text, font));
                this._stopLabelGeometry = label;
                if (label) this._pxBounds.extend(label.min).extend(label.max);
            },
        });
        classes.set(L, { Renderer, Marker });
    }
    const { Renderer, Marker } = classes.get(L);
    const renderer = new Renderer({ padding: 0.25, tolerance: 12 });
    return { renderer, circleMarker: (point, options) => new Marker(point, { ...options, renderer }) };
}
