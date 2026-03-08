const fs = require('fs');
let content = fs.readFileSync('src/pages/ZipCodeExplorer.jsx', 'utf8');

// Replace imports
content = content.replace(
  "import { MapContainer, TileLayer, Marker, Popup, useMap, Polyline, CircleMarker, Tooltip, LayerGroup } from 'react-leaflet';",
  "import Map, { Source, Layer } from 'react-map-gl';\nimport 'maplibre-gl/dist/maplibre-gl.css';\nimport maplibregl from 'maplibre-gl';\nimport { useMemo, useRef } from 'react';"
);

// Remove Leaflet css and L imports
content = content.replace(/import 'leaflet\/dist\/leaflet\.css';\nimport L from 'leaflet';\n/, "");

// Remove Leaflet icon fixes
const leafletFixRegex = /\/\/ Fix leaflet marker icons\s+delete L\.Icon\.Default\.prototype\._getIconUrl;\s+L\.Icon\.Default\.mergeOptions\(\{[\s\S]*?\}\);\s+/g;
content = content.replace(leafletFixRegex, "");

// Replace MapMover
const mapMoverRegex = /\/\/ Component to move map to new center\nfunction MapMover\(\{[\s\S]*?return null;\n\}\n/g;
content = content.replace(mapMoverRegex, "");

fs.writeFileSync('src/pages/ZipCodeExplorer.jsx', content);
