const fs = require('fs');
let content = fs.readFileSync('src/components/map/ManagerMapLayers.jsx', 'utf8');

const replacement = `            {/* 6. Martin Vector Tiles (Phase 3 Integration) */}
            <Source
                id="martin-tiles"
                type="vector"
                url="http://localhost:3000/public.properties"
            >
                {/* Points */}
                <Layer
                    id="martin-points"
                    type="circle"
                    source="martin-tiles"
                    source-layer="public.properties"
                    paint={{
                        'circle-radius': 4,
                        'circle-color': '#6C5CE7',
                        'circle-stroke-width': 1,
                        'circle-stroke-color': '#ffffff'
                    }}
                />
            </Source>
        </>
    );
}`;

content = content.replace(/        <\/>\n    \);\n\}/, replacement);

fs.writeFileSync('src/components/map/ManagerMapLayers.jsx', content);
