import { Client } from '@neondatabase/serverless';

const CONNECTION_STRING = 'postgresql://neondb_owner:npg_jsLScDO6w9mf@ep-fragrant-bush-ahixbnax-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require';

export class DarkRoomClient {
    constructor() {
        this.client = new Client(CONNECTION_STRING);
        this.isConnected = false;
        this.connectPromise = null;
    }

    async connect() {
        if (this.isConnected) return;
        if (this.connectPromise) return this.connectPromise;

        this.connectPromise = this.client.connect()
            .then(() => {
                this.isConnected = true;
                console.log('[DarkRoom] Connected to Neon DB');
            })
            .catch(err => {
                console.error('[DarkRoom] Connection error:', err);
                this.connectPromise = null;
                throw err;
            });
            
        return this.connectPromise;
    }

    /**
     * Fetches properties within the given map bounds.
     * Uses PostGIS to query only relevant points.
     * @param {Object} bounds - Leaflet bounds object (getBounds())
     * @param {number} zoom - Current zoom level
     */
    async fetchPropertiesInViewport(bounds, zoom) {
        await this.connect();

        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();

        // Query optimization:
        // 1. Filter by viewport (ST_MakeEnvelope)
        // 2. If zoom is low (< 13), limit results to high smart_score only to prevent clutter
        // 3. Select only necessary columns
        
        let scoreFilter = '';
        if (zoom < 10) scoreFilter = 'AND smart_score > 90';
        else if (zoom < 12) scoreFilter = 'AND smart_score > 75';
        else if (zoom < 14) scoreFilter = 'AND smart_score > 50';

        // NOTE: Assuming table name is 'properties' and has 'location' column of type GEOGRAPHY/GEOMETRY
        // We cast location to geometry for ST_MakeEnvelope interaction if needed, or use coordinates directly.
        // Assuming columns: id, address, city, state, zip_code, smart_score, sold_date, ST_X(location::geometry) as lng, ST_Y(location::geometry) as lat
        
        const query = `
            SELECT 
                id, 
                address, 
                city, 
                state, 
                zip_code, 
                smart_score, 
                turnover_prob,
                sold_date,
                ST_X(location::geometry) as lng, 
                ST_Y(location::geometry) as lat
            FROM properties
            WHERE 
                location && ST_MakeEnvelope($1, $2, $3, $4, 4326)
                ${scoreFilter}
            LIMIT 1000;
        `;

        try {
            const res = await this.client.query(query, [sw.lng, sw.lat, ne.lng, ne.lat]);
            return res.rows.map(row => ({
                ...row,
                effective_status: this.getSmartStatus(row.smart_score), // Map to app status logic
                is_dark_room: true
            }));
        } catch (error) {
            console.error('[DarkRoom] Query failed:', error);
            return [];
        }
    }

    getSmartStatus(score) {
        if (score >= 90) return 'QUALIFIED'; // Hot lead
        if (score >= 70) return 'CALLBACK'; // Warm lead
        return 'ELIGIBLE'; // Cold/Standard
    }
}

export const darkRoom = new DarkRoomClient();