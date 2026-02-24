import React, { useState, useEffect } from 'react';
import { useMapEvents, Polyline, Polygon, CircleMarker } from 'react-leaflet';

export default function MapDrawTool({ active, onPointsUpdate, drawnPolygon }) {
    const [points, setPoints] = useState([]);
    const [mousePos, setMousePos] = useState(null);

    useMapEvents({
        click(e) {
            if (!active) return;
            const newPoints = [...points, e.latlng];
            setPoints(newPoints);
            if (onPointsUpdate) {
                onPointsUpdate(newPoints);
            }
        },
        mousemove(e) {
            if (!active) return;
            setMousePos(e.latlng);
        }
    });

    useEffect(() => {
        if (!active) {
            setPoints([]);
            setMousePos(null);
        }
    }, [active]);

    const displayPoints = active ? points : (drawnPolygon || []);

    if (displayPoints.length === 0) return null;

    return (
        <>
            {active && displayPoints.length > 0 && mousePos && (
                <Polyline 
                    positions={[...displayPoints, mousePos]} 
                    pathOptions={{ color: '#FFD93D', dashArray: '5,5', weight: 2 }} 
                />
            )}
            {displayPoints.length > 2 && (
                <Polygon 
                    positions={displayPoints} 
                    pathOptions={{ fillColor: '#FFD93D', color: '#FFD93D', fillOpacity: 0.2, weight: active ? 0 : 2 }} 
                />
            )}
            {displayPoints.map((p, i) => (
                <CircleMarker 
                    key={i} 
                    center={p} 
                    radius={active ? 4 : 2} 
                    pathOptions={{ color: '#FFD93D', fillColor: '#000', fillOpacity: 1, weight: 1 }} 
                />
            ))}
        </>
    );
}