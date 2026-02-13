// Dark Room / Neon integration removed — stub to prevent import errors

export class DarkRoomClient {
    static getScoreColor() { return '#666666'; }
}

export const darkRoom = {
    testConnection: async () => ({ connected: false, totalProperties: 0 }),
    fetchPropertiesInViewport: async () => [],
    fetchPropertyDetails: async () => null,
    fetchClusters: async () => [],
    getTotalCount: async () => 0,
    getDataQualityReport: async () => null,
    getGeographicDistribution: async () => null,
};