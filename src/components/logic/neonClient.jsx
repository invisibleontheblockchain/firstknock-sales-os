import { neon } from '@neondatabase/serverless';

// Live Dark Room Database Connection (94k+ off-market properties)
const CONNECTION_STRING = 'postgresql://neondb_owner:npg_jsLScDO6w9mf@ep-fragrant-bush-ahixbnax-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require';

export class DarkRoomClient {
    constructor() {
        this.sql = null;
        this.isConnected = false;
        this.connectPromise = null;
        this.clusterCache = new Map();
        this.cacheExpiry = 30000; // 30 second cache
    }

    async connect() {
        if (this.isConnected && this.sql) return this.sql;
        if (this.connectPromise) return this.connectPromise;

        this.connectPromise = (async () => {
            try {
                this.sql = neon(CONNECTION_STRING);
                // Test the connection with a simple query
                const testResult = await this.sql`SELECT 1 as test`;
                if (testResult && testResult[0]?.test === 1) {
                    this.isConnected = true;
                    console.log('[DarkRoom] ✅ Connected to Neon DB successfully');
                    return this.sql;
                } else {
                    throw new Error('Connection test failed');
                }
            } catch (error) {
                console.error('[DarkRoom] ❌ Connection error:', error.message || error);
                this.connectPromise = null;
                this.isConnected = false;
                throw error;
            }
        })();
            
        return this.connectPromise;
    }

    /**
     * Test connection and return diagnostic info
     */
    async testConnection() {
        try {
            const sql = await this.connect();
            const countResult = await sql`SELECT COUNT(*) as count FROM properties`;
            const sampleResult = await sql`SELECT id, address, smart_score FROM properties LIMIT 1`;
            
            return {
                connected: true,
                totalProperties: parseInt(countResult[0]?.count) || 0,
                sampleProperty: sampleResult[0] || null,
                message: 'Database connection successful'
            };
        } catch (error) {
            return {
                connected: false,
                totalProperties: 0,
                sampleProperty: null,
                message: error.message || 'Connection failed'
            };
        }
    }

    /**
     * Get data quality report - check which fields are populated
     */
    async getDataQualityReport() {
        try {
            const sql = await this.connect();
            const result = await sql`
                SELECT 
                    COUNT(*) as total,
                    COUNT(location) as has_location,
                    COUNT(smart_score) as has_smart_score,
                    COUNT(NULLIF(smart_score, 0)) as has_nonzero_score,
                    COUNT(address) as has_address,
                    COUNT(city) as has_city,
                    COUNT(state) as has_state,
                    COUNT(zip_code) as has_zip,
                    COUNT(sold_date) as has_sold_date,
                    COUNT(beds) as has_beds,
                    COUNT(baths) as has_baths,
                    COUNT(sqft) as has_sqft,
                    COUNT(price) as has_price,
                    COUNT(equity) as has_equity,
                    COUNT(year_built) as has_year_built,
                    COUNT(turnover_prob) as has_turnover_prob,
                    AVG(smart_score) as avg_score,
                    MIN(smart_score) as min_score,
                    MAX(smart_score) as max_score
                FROM properties
            `;
            return result[0];
        } catch (error) {
            console.error('[DarkRoom] Data quality check failed:', error);
            return null;
        }
    }

    // Generate cache key from viewport
    _viewportKey(bounds, zoom) {
        const sw = bounds._southWest || bounds.getSouthWest?.() || bounds;
        const ne = bounds._northEast || bounds.getNorthEast?.() || bounds;
        return `${sw.lat?.toFixed(3) || 0},${sw.lng?.toFixed(3) || 0},${ne.lat?.toFixed(3) || 0},${ne.lng?.toFixed(3) || 0},${zoom}`;
    }

    /**
     * Fetch CLUSTERED data for low/mid zoom levels (zoom < 14)
     * Uses PostGIS ST_ClusterDBSCAN for server-side clustering
     */
    async fetchClusters(bounds, zoom) {
        try {
            const sql = await this.connect();
            const sw = bounds._southWest || bounds.getSouthWest?.() || { lat: bounds.south, lng: bounds.west };
            const ne = bounds._northEast || bounds.getNorthEast?.() || { lat: bounds.north, lng: bounds.east };

            // Check cache
            const cacheKey = this._viewportKey(bounds, zoom);
            const cached = this.clusterCache.get(cacheKey);
            if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
                return cached.data;
            }

            // Cluster epsilon based on zoom (larger = bigger clusters at low zoom)
            const epsilon = zoom <= 8 ? 0.5 : zoom <= 10 ? 0.2 : zoom <= 12 ? 0.05 : 0.02;

            const result = await sql`
                WITH viewport_properties AS (
                    SELECT 
                        id,
                        location,
                        smart_score,
                        ST_ClusterDBSCAN(location::geometry, eps := ${epsilon}, minpoints := 3) 
                            OVER () AS cluster_id
                    FROM properties
                    WHERE location && ST_MakeEnvelope(${sw.lng}, ${sw.lat}, ${ne.lng}, ${ne.lat}, 4326)
                )
                SELECT 
                    cluster_id,
                    COUNT(*) as property_count,
                    AVG(smart_score) as avg_score,
                    ST_Y(ST_Centroid(ST_Collect(location::geometry))) as lat,
                    ST_X(ST_Centroid(ST_Collect(location::geometry))) as lng,
                    MAX(smart_score) as max_score
                FROM viewport_properties
                WHERE cluster_id IS NOT NULL
                GROUP BY cluster_id
                ORDER BY avg_score DESC
                LIMIT 200
            `;

            const clusters = result.map(row => ({
                id: `cluster_${row.cluster_id}`,
                lat: parseFloat(row.lat),
                lng: parseFloat(row.lng),
                count: parseInt(row.property_count),
                avgScore: parseFloat(row.avg_score || 0),
                maxScore: parseFloat(row.max_score || 0),
                isCluster: true
            }));

            this.clusterCache.set(cacheKey, { data: clusters, timestamp: Date.now() });
            return clusters;

        } catch (error) {
            console.error('[DarkRoom] Cluster query failed:', error);
            return [];
        }
    }

    /**
     * Fetches properties within the given map bounds.
     * Uses PostGIS for viewport filtering and smart_score for prioritization.
     * At low zoom, returns clusters. At high zoom, returns individual pins.
     */
    async fetchPropertiesInViewport(bounds, zoom) {
        try {
            const sql = await this.connect();

            const sw = bounds._southWest || bounds.getSouthWest?.() || { lat: bounds.south, lng: bounds.west };
            const ne = bounds._northEast || bounds.getNorthEast?.() || { lat: bounds.north, lng: bounds.east };

            // For very low zoom only, use clusters to prevent browser crash
            if (zoom < 10) {
                return this.fetchClusters(bounds, zoom);
            }

            // High zoom: individual properties - no limit to show all 94k
            const limit = 10000; // Allow full viewport load
            const minScore = 0; // Show all scores

            const result = await sql`
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
                    location && ST_MakeEnvelope(${sw.lng}, ${sw.lat}, ${ne.lng}, ${ne.lat}, 4326)
                    AND (smart_score >= ${minScore} OR smart_score IS NULL)
                ORDER BY smart_score DESC NULLS LAST, turnover_prob DESC NULLS LAST
                LIMIT ${limit}
            `;

            return result.map(row => ({
                id: row.id,
                address_hash: row.id,
                full_address: row.address,
                street_name: row.address?.split(' ').slice(1).join(' ') || '',
                house_number: parseInt(row.address?.split(' ')[0]) || 0,
                city: row.city,
                state: row.state,
                zip_code: row.zip_code,
                lat: parseFloat(row.lat),
                lng: parseFloat(row.lng),
                smart_score: parseFloat(row.smart_score) || 0,
                turnover_prob: parseFloat(row.turnover_prob) || 0,
                sold_date: row.sold_date,
                effective_status: this.getSmartStatus(row.smart_score),
                is_dark_room: true
            }));

        } catch (error) {
            console.error('[DarkRoom] Viewport query failed:', error);
            return [];
        }
    }

    /**
     * Lazy load full property details when a pin is clicked
     */
    async fetchPropertyDetails(propertyId) {
        try {
            const sql = await this.connect();
            
            const result = await sql`
                SELECT 
                    id,
                    address,
                    city,
                    state,
                    zip_code,
                    ST_Y(location::geometry) as lat,
                    ST_X(location::geometry) as lng,
                    smart_score,
                    turnover_prob,
                    sold_date,
                    beds,
                    baths,
                    sqft,
                    lot_size,
                    year_built,
                    price,
                    equity,
                    property_type,
                    owner_name,
                    mls_id
                FROM properties
                WHERE id = ${propertyId}
                LIMIT 1
            `;

            if (result.length === 0) return null;

            const row = result[0];
            return {
                id: row.id,
                address_hash: row.id,
                full_address: row.address,
                street_name: row.address?.split(' ').slice(1).join(' ') || '',
                house_number: parseInt(row.address?.split(' ')[0]) || 0,
                city: row.city,
                state: row.state,
                zip_code: row.zip_code,
                lat: parseFloat(row.lat),
                lng: parseFloat(row.lng),
                smart_score: parseFloat(row.smart_score) || 0,
                turnover_prob: parseFloat(row.turnover_prob) || 0,
                sold_date: row.sold_date,
                beds: row.beds,
                baths: row.baths,
                sqft: row.sqft,
                lot_size: row.lot_size,
                year_built: row.year_built,
                price: row.price,
                equity: row.equity,
                property_type: row.property_type,
                owner_name: row.owner_name,
                mls_id: row.mls_id,
                effective_status: this.getSmartStatus(row.smart_score),
                is_dark_room: true
            };

        } catch (error) {
            console.error('[DarkRoom] Property details fetch failed:', error);
            return null;
        }
    }

    /**
     * Get total count of properties in Dark Room
     */
    async getTotalCount() {
        try {
            const sql = await this.connect();
            const result = await sql`SELECT COUNT(*) as count FROM properties`;
            return parseInt(result[0]?.count) || 0;
        } catch (error) {
            console.error('[DarkRoom] Count query failed:', error);
            return 0;
        }
    }

    /**
     * Determine status based on smart_score for color coding
     */
    getSmartStatus(score) {
        if (score >= 80) return 'QUALIFIED'; // Hot lead - Green
        if (score >= 50) return 'CALLBACK';  // Warm - Yellow
        return 'ELIGIBLE'; // Cold/Standard - Gray
    }

    /**
     * Get color for visualization based on smart_score
     */
    static getScoreColor(score) {
        if (score >= 90) return '#00ff00'; // Bright green - HOT
        if (score >= 70) return '#7fff00'; // Chartreuse - Very Warm  
        if (score >= 50) return '#ffff00'; // Yellow - Warm
        if (score >= 30) return '#ffa500'; // Orange - Cool
        return '#666666'; // Gray - Cold
    }
}

export const darkRoom = new DarkRoomClient();