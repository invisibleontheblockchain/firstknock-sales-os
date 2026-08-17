/**
 * Phase 0 — read the STORED routing provenance for a saved route.
 *
 * READ ONLY. Lists routes and prints their routing metadata; never writes.
 *
 * Answers the question a route's mileage cannot: was this order actually
 * produced by the road-aware hierarchy, and if so, which decomposition did it
 * take, did anything degrade, and did the solve finish inside the interactive
 * deadline? A 628-mile route is consistent with both "geometric windows" and
 * "the road pass timed out and the aerial continuity order shipped" — these
 * fields are what tell the two apart.
 *
 * Usage:
 *   BASE44_TOKEN=<access token> node scripts/route-routing-provenance.mjs [name-filter]
 *
 * The token is `localStorage.base44_access_token` in a logged-in browser tab on
 * the app origin. Pass it through the environment; never hard-code it here.
 *
 *   node scripts/route-routing-provenance.mjs            # every route, summary
 *   node scripts/route-routing-provenance.mjs 1H         # routes whose name matches /1H/i
 */

import { createClient } from '@base44/sdk';

const APP_ID = process.env.BASE44_APP_ID || '695eb764b077190880be21de';
const APP_BASE_URL = process.env.BASE44_APP_BASE_URL || 'https://firstknock.online';
const TOKEN = process.env.BASE44_TOKEN || undefined;
const FILTER = process.argv[2] || '';

// Grouped so the output reads as an argument, not a field dump.
const FIELD_GROUPS = [
    ['Which decomposition ran', [
        'decomposition', 'window_grouping_road_priced', 'strategy', 'selected_decomposition',
        'matrix_tier', 'street_block_count', 'matrix_street_block_count', 'cluster_count',
        'max_window_doors', 'window_offset_doors', 'coarse_group_count'
    ]],
    ['Was the order road-priced, honestly', [
        'road_network_used', 'fallback', 'fallback_status', 'fallback_reason',
        'road_aware_degraded', 'road_aware_degradation_reason', 'optimality_status',
        'distance_estimate', 'cluster_order_road_priced', 'order_affecting_aerial_decisions',
        'aerial_priced_legs', 'clusters_degraded_to_aerial', 'degraded',
        'degraded_cluster_reasons', 'road_aware_leg_pct', 'exact_once_verified',
        'final_route_aerial_cross_street_legs', 'intra_cluster_road_priced_legs'
    ]],
    ['Did it finish in time', [
        'solver_runtime_ms', 'road_matrix_ms', 'sequencing_ms', 'decomposition_portfolio_ms',
        'matrix_request_count', 'road_pairs_requested', 'osrm_requests', 'osrm_retries',
        'osrm_rate_limited', 'osrm_peak_concurrency'
    ]],
    ['What mileage the product believes', [
        'validated_road_miles', 'current_validated_road_miles', 'road_miles_saved',
        'winning_route_distance', 'input_measured', 'road_aware_measured', 'improvement',
        'validated_longest_leg_miles', 'road_path_validated', 'road_path_error',
        'baseline_decomposition_miles', 'decomposition_miles_saved_vs_baseline'
    ]],
    ['Repairs', [
        'barrier_windows_checked', 'barrier_straddling_windows', 'barrier_blocks_moved',
        'barrier_doors_moved', 'barrier_repair_passes', 'seam_matrix_requests',
        'hotspot_matrix_requests', 'selected_candidate_type', 'candidate_count'
    ]],
    ['Versions', [
        'hierarchy_version', 'optimizer_version', 'objective_version', 'road_matrix_version',
        'sequencer_version', 'property_order_fingerprint'
    ]]
];
const KNOWN = new Set(FIELD_GROUPS.flatMap(([, keys]) => keys));

const render = (value) => (value && typeof value === 'object' ? JSON.stringify(value) : String(value));

function printGrouped(source) {
    let printed = 0;
    FIELD_GROUPS.forEach(([heading, keys]) => {
        const present = keys.filter((key) => source[key] !== undefined);
        if (present.length === 0) return;
        console.log(`\n  ${heading}`);
        present.forEach((key) => {
            console.log(`    ${key.padEnd(38)} ${render(source[key])}`);
        });
        printed += present.length;
    });
    const extra = Object.keys(source).filter((key) => !KNOWN.has(key));
    if (extra.length > 0) console.log(`\n  Other keys present: ${extra.join(', ')}`);
    if (printed === 0) console.log('\n  None of the routing-provenance fields are present.');
    return printed;
}

async function run() {
    if (!TOKEN) {
        console.log('No BASE44_TOKEN set — the app requires an authenticated session.');
        console.log('Get it from a logged-in tab on the app origin:');
        console.log('    localStorage.base44_access_token');
        console.log('then re-run with BASE44_TOKEN=<that value>.');
        process.exitCode = 2;
        return;
    }

    const base44 = createClient({
        appId: APP_ID,
        token: TOKEN,
        requiresAuth: false,
        appBaseUrl: APP_BASE_URL
    });

    let routes = [];
    try {
        const response = await base44.entities.SavedRoute.list('-created_date', 300);
        routes = Array.isArray(response) ? response : (response?.items || []);
    } catch (error) {
        console.log(`Could not list routes: ${error.message}`);
        process.exitCode = 1;
        return;
    }

    const matched = FILTER
        ? routes.filter((route) => new RegExp(FILTER, 'i').test(route.name || ''))
        : routes;
    console.log(`${routes.length} routes visible; ${matched.length} match${FILTER ? ` /${FILTER}/i` : ''}.`);

    if (matched.length === 0) {
        console.log('\nRoute names available:');
        routes.slice(0, 60).forEach((route) => {
            console.log(`  ${route.id}  ${route.name}  (${(route.property_hashes || []).length} stops, ${route.created_date})`);
        });
        return;
    }

    matched.forEach((route) => {
        const metadata = route.metadata || {};
        console.log(`\n${'='.repeat(76)}`);
        console.log(`${route.name}`);
        console.log(`  id ${route.id} · ${(route.property_hashes || []).length} stops · created ${route.created_date}`);
        console.log(`  stored total_distance: ${route.total_distance}`);

        printGrouped(metadata);

        if (metadata.routing) {
            console.log('\n  metadata.routing (persisted provenance block)');
            Object.entries(metadata.routing).forEach(([key, value]) => {
                console.log(`    ${key.padEnd(38)} ${render(value)}`);
            });
        } else {
            console.log('\n  metadata.routing: ABSENT — no road-matrix provenance was ever written.');
        }
    });
}

run().catch((error) => {
    console.log('ERROR:', error.message);
    process.exitCode = 1;
});
