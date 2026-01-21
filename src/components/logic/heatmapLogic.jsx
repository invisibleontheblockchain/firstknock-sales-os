/**
 * Logic for generating a grid-based heatmap overlay
 * Aggregates individual points into "Hot Cells" for high-level visualization
 */

import { scoreProperty } from './routeOptimizer';

const GRID_SIZE_MILES = 0.25; // Size of each heat cell (approx 1/4 mile)

export function generateHeatmapGrid(properties) {
    if (!properties || properties.length === 0) return [];

    const grid = {};

    properties.forEach(p => {
        if (!p.lat || !p.lng) return;

        // Create a grid key based on rounded coordinates (bucketing)
        // 1 degree lat ~ 69 miles. 0.004 degrees ~ 0.25 miles
        const latKey = Math.floor(p.lat / 0.004);
        const lngKey = Math.floor(p.lng / 0.004);
        const key = `${latKey},${lngKey}`;

        if (!grid[key]) {
            grid[key] = {
                id: key,
                lat: (latKey * 0.004) + 0.002, // Center of cell
                lng: (lngKey * 0.004) + 0.002,
                count: 0,
                totalScore: 0,
                properties: []
            };
        }

        const score = scoreProperty(p);
        grid[key].count++;
        grid[key].totalScore += score;
        grid[key].properties.push(p);
    });

    // Convert to array and normalize intensity
    return Object.values(grid).map(cell => ({
        ...cell,
        avgScore: cell.totalScore / cell.count,
        intensity: Math.min(1, cell.count / 10) // Cap intensity at 10 homes per cell for opacity
    }));
}

export function getHeatColor(avgScore) {
    // Gradient from Red (Low) to Yellow (Med) to Green (High)
    // Actually for "Hot" leads, maybe Red is Hot? 
    // Let's stick to the brand: Gold/Yellow is Hot/Target.
    
    if (avgScore > 200) return '#FFD700'; // Super Hot (Gold)
    if (avgScore > 150) return '#f59e0b'; // Hot (Amber)
    if (avgScore > 100) return '#f97316'; // Warm (Orange)
    return '#3b82f6'; // Cold (Blue)
}