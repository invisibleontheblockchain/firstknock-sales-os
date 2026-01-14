import localforage from 'localforage';

// Initialize storage instances
const propertyStore = localforage.createInstance({
    name: 'firstknock-sales-os',
    storeName: 'properties'
});

const routeStore = localforage.createInstance({
    name: 'firstknock-sales-os',
    storeName: 'routes'
});

export const storage = {
    // Properties
    saveProperties: async (properties) => {
        try {
            // Get existing properties first to merge
            const existing = await propertyStore.getItem('all_properties') || [];

            // Create a map by address_hash for deduplication
            const propMap = new Map();
            existing.forEach(p => propMap.set(p.address_hash, p));
            properties.forEach(p => propMap.set(p.address_hash, p));

            const merged = Array.from(propMap.values());
            await propertyStore.setItem('all_properties', merged);
            return merged.length;
        } catch (error) {
            console.error('Local storage save error:', error);
            throw error;
        }
    },

    getProperties: async () => {
        try {
            return await propertyStore.getItem('all_properties') || [];
        } catch (error) {
            console.error('Local storage read error:', error);
            return [];
        }
    },

    clearProperties: async () => {
        await propertyStore.removeItem('all_properties');
    },

    // Routes
    saveRoute: async (route) => {
        const routes = await routeStore.getItem('saved_routes') || [];
        routes.unshift(route); // Add to beginning
        await routeStore.setItem('saved_routes', routes);
        return routes;
    },

    getRoutes: async () => {
        return await routeStore.getItem('saved_routes') || [];
    }
};
