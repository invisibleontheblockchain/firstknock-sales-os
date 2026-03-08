const fs = require('fs');
let content = fs.readFileSync('src/pages/ZipCodeExplorer.jsx', 'utf8');

// Replace imports
content = content.replace(
  "import { MapContainer, TileLayer, Marker, Popup, useMap, Polyline, CircleMarker, Tooltip, LayerGroup } from 'react-leaflet';",
  "import Map, { Source, Layer, Popup as MapPopup } from 'react-map-gl';\nimport 'maplibre-gl/dist/maplibre-gl.css';\nimport maplibregl from 'maplibre-gl';\nimport { useMemo, useRef } from 'react';"
);

// Remove Leaflet css and L imports
content = content.replace(/import 'leaflet\/dist\/leaflet\.css';\nimport L from 'leaflet';\n/, "");

// Remove Leaflet icon fixes
const leafletFixRegex = /\/\/ Fix leaflet marker icons\s+delete L\.Icon\.Default\.prototype\._getIconUrl;\s+L\.Icon\.Default\.mergeOptions\(\{[\s\S]*?\}\);\s+/g;
content = content.replace(leafletFixRegex, "");

// Replace MapMover
const mapMoverRegex = /\/\/ Component to move map to new center\nfunction MapMover\(\{[\s\S]*?return null;\n\}\n/g;
content = content.replace(mapMoverRegex, "");

// First add mapRef definition in ZipCodeExplorer
content = content.replace("export default function ZipCodeExplorer() {", "export default function ZipCodeExplorer() {\n  const mapRef = useRef(null);");

// Replace centering logic to use mapRef instead of state
content = content.replace("setSearchId(prev => prev + 1); // Trigger map move", "if(mapRef.current) mapRef.current.flyTo({center: [avgLng, avgLat], zoom: 14});");
content = content.replace("setSearchId(prev => prev + 1);\n\n        // Create single", "if(mapRef.current) mapRef.current.flyTo({center: [avgLng, avgLat], zoom: 14});\n\n        // Create single");


// Replace MapContainer block
const mapReplacement = `
        <div className="flex-1 relative">
          <Map
            ref={mapRef}
            initialViewState={{
              longitude: mapCenter[1],
              latitude: mapCenter[0],
              zoom: mapZoom
            }}
            mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
            style={{ width: '100%', height: '100%', position: 'absolute', inset: 0 }}
          >
            {generatedRoutes.length === 0 && properties.length > 0 && (
              <Source id="properties" type="geojson" data={{
                type: 'FeatureCollection',
                features: properties.map(p => ({
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                  properties: p
                }))
              }}>
                <Layer
                  id="properties-layer"
                  type="circle"
                  paint={{
                    'circle-radius': 6,
                    'circle-color': '#3b82f6',
                    'circle-opacity': 0.8,
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#1d4ed8'
                  }}
                />
              </Source>
            )}

            {generatedRoutes.map((route, rIdx) => {
              const color = ROUTE_COLORS[rIdx % ROUTE_COLORS.length];
              const isActive = activeRoute === route;

              return (
                <React.Fragment key={rIdx}>
                  {isActive && (
                    <Source id={\`route-line-\${rIdx}\`} type="geojson" data={{
                      type: 'Feature',
                      geometry: {
                        type: 'LineString',
                        coordinates: route.properties.map(p => [p.lng, p.lat])
                      }
                    }}>
                      <Layer
                        id={\`route-line-layer-\${rIdx}\`}
                        type="line"
                        paint={{
                          'line-color': color,
                          'line-width': 3,
                          'line-opacity': 0.8,
                          'line-dasharray': [2, 2]
                        }}
                      />
                    </Source>
                  )}

                  <Source id={\`route-points-\${rIdx}\`} type="geojson" data={{
                    type: 'FeatureCollection',
                    features: route.properties.map((p, pIdx) => ({
                      type: 'Feature',
                      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                      properties: { index: pIdx + 1, pointIdx: \`\${rIdx}-\${pIdx}\` }
                    }))
                  }}>
                    <Layer
                      id={\`route-points-layer-\${rIdx}\`}
                      type="circle"
                      paint={{
                        'circle-radius': isActive ? 8 : 5,
                        'circle-color': color,
                        'circle-opacity': isActive ? 0.9 : 0.6,
                        'circle-stroke-width': 1,
                        'circle-stroke-color': 'white'
                      }}
                    />
                    {isActive && (
                      <Layer
                        id={\`route-labels-layer-\${rIdx}\`}
                        type="symbol"
                        layout={{
                          'text-field': ['to-string', ['get', 'index']],
                          'text-size': 10,
                          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold']
                        }}
                        paint={{
                          'text-color': '#ffffff'
                        }}
                      />
                    )}
                  </Source>
                </React.Fragment>
              );
            })}
          </Map>
        </div>
`;

// Extract everything before the map container
const mapIdx = content.indexOf('<div className="flex-1 relative">');
// Find the end of MapContainer
let endIdx = content.indexOf('</MapContainer>', mapIdx);
if(endIdx > -1) {
    const endDivIdx = content.indexOf('</div>', endIdx);
    content = content.substring(0, mapIdx) + mapReplacement + content.substring(endDivIdx + 6);
}

fs.writeFileSync('src/pages/ZipCodeExplorer.jsx', content);
