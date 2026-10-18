// The manager map's saved-route list asks Base44 for these fields only.
//
// A full SavedRoute carries its saved road path (metadata.road_geometry_segments,
// ~300 KB on an optimized 1,000-stop route). The map never draws it: route lines
// run between the stops (ManagerMapLayers getRouteLinePoints). For the owner's
// 43 routes the full list was 5.2 MB and 2-3 s of server time; without the path
// it is 1.4 MB and 0.6-1.0 s. Base44 can only include fields, not exclude one,
// so this names every top-level field and every metadata key a route carries
// (from a scan of live routes plus the keys the app reads), except the path.
//
// A route from this list therefore lacks its road path and any metadata key
// added after this list was written. Saves that rebuild a route's metadata
// start from the stored record instead (readStoredRouteMetadata).

export const MAP_ROUTE_OMITTED_METADATA = Object.freeze(['road_geometry_segments', 'road_geometry']);

export const MAP_ROUTE_TOP_LEVEL_FIELDS = Object.freeze([
    'assigned_to', 'assigned_to_name', 'batch_date', 'batch_number', 'batch_total', 'created_by', 'created_by_id',
    'created_date', 'description', 'end_location', 'id', 'is_sample', 'manager_id', 'metrics', 'name',
    'parent_route_id', 'priority', 'property_hashes', 'route_mode', 'route_origin_mode', 'start_location',
    'status', 'updated_date',
]);

export const MAP_ROUTE_METADATA_KEYS = Object.freeze([
    'access_block_count', 'aerial_evaluation_cross_street_same_unit', 'aerial_evaluation_same_street_block',
    'aerial_priced_legs', 'anchor', 'anchor_legs_measured', 'barrier_blocks_moved', 'barrier_components_moved',
    'barrier_doors_moved', 'barrier_excess_miles', 'barrier_new_windows', 'barrier_repair_passes',
    'barrier_repair_version', 'barrier_straddling_windows', 'barrier_windows_checked', 'candidate_count',
    'cluster_count', 'cluster_order_road_priced', 'cluster_seam_legs', 'clusters_degraded_to_aerial',
    'clusters_sequenced_on_exact_door_matrix', 'continuity_measured', 'county_road_routing',
    'current_leg_distribution', 'current_longest_leg_miles', 'current_route_distance', 'current_route_duration',
    'current_validated_road_miles', 'decomposition', 'degraded', 'degraded_cluster_reasons', 'distance_estimate',
    'distance_improvement', 'duration_improvement', 'duration_tie_tolerance_minutes', 'end_constraint',
    'exact_once_verified', 'fallback', 'fallback_reason', 'fallback_status', 'file_name', 'final_leg_distribution',
    'final_route_aerial_cross_street_legs', 'final_route_aerial_same_street_block_legs', 'final_route_leg_count',
    'final_route_road_legs', 'generated_at', 'global_candidate_verification', 'hierarchy_version',
    'hotspot_candidates_examined', 'hotspot_candidates_improved', 'hotspot_matrix_requests',
    'hotspot_measure_requests', 'hotspot_miles_saved', 'hotspot_rounds_accepted', 'hotspot_rounds_run',
    'hotspot_skipped_reason', 'hotspot_widths', 'import_optimization', 'imports', 'improvement', 'input_measured',
    'intra_block_aerial_leg_count', 'intra_cluster_road_priced_legs', 'last_optimization_attempt',
    'matrix_block_count', 'matrix_point_count', 'matrix_provider', 'matrix_request_count',
    'matrix_street_block_count', 'matrix_tier', 'matrix_unresolved_count', 'max_window_doors',
    'neighborhood_excursion_review', 'newly_generated', 'objective', 'objective_version', 'optimality_status',
    'optimization_timings', 'optimizer_version', 'order_affecting_aerial_decisions', 'osrm_max_concurrency_cap',
    'osrm_peak_concurrency', 'osrm_rate_limited', 'osrm_requests', 'osrm_retries', 'pre_hotspot_leg_distribution',
    'precision_area', 'property_order_fingerprint', 'property_set_fingerprint', 'repair_matrix_requests',
    'repair_road_pairs', 'rerun_created_at', 'rerun_filter', 'rerun_from_route_id', 'return_to_start',
    'road_access_recovery', 'road_aware_comparison_id', 'road_aware_degradation_reason', 'road_aware_degraded',
    'road_aware_leg_pct', 'road_aware_measured', 'road_build_id', 'road_cost_cache', 'road_geometry_provenance',
    'road_matrix_cache_key', 'road_matrix_ms', 'road_matrix_snapped', 'road_matrix_source',
    'road_matrix_unresolved_legs', 'road_matrix_version', 'road_miles_saved', 'road_network_used',
    'road_pairs_requested', 'road_path_error', 'road_path_unmatched_stops', 'road_path_validated',
    'road_path_widened_stop_count', 'road_response_cache', 'road_search_baseline_distance',
    'road_search_comparison', 'road_search_coverage', 'road_search_passes', 'road_search_session',
    'road_search_stop_reason', 'road_verification', 'route_bounds', 'routing', 'routing_profile',
    'save_request_id', 'seam_matrix_requests', 'seam_miles_saved', 'seam_passes', 'seam_road_pairs_requested',
    'seams_examined', 'seams_improved', 'seams_rejected_no_gain', 'seams_skipped_unresolved',
    'selected_candidate_type', 'sequencing_ms', 'solver_runtime_ms', 'source', 'split_replacement', 'split_source',
    'start_constraint', 'strategy', 'street_block_count', 'validated_leg_distribution',
    'validated_longest_leg_miles', 'validated_road_miles', 'window_grouping_road_priced', 'window_offset_doors',
    'winning_route_distance', 'winning_route_duration',
]);

export const MAP_ROUTE_FIELDS = Object.freeze([
    ...MAP_ROUTE_TOP_LEVEL_FIELDS,
    ...MAP_ROUTE_METADATA_KEYS.map((key) => `metadata.${key}`),
]);

/**
 * The stored metadata of a saved route, read fresh. The map holds routes
 * without their road path (MAP_ROUTE_FIELDS), so any save that rebuilds
 * metadata must start from this, never from the map's copy. Refuses rather
 * than guessing when the route cannot be read.
 */
export async function readStoredRouteMetadata(client, route) {
    if (!route?.id || route.isSaved === false || String(route.id).startsWith('local_')) return route?.metadata || {};
    let stored = null;
    try { stored = await client.entities.SavedRoute.get(route.id); } catch { stored = null; }
    if (!stored?.id) throw new Error('This route could not be re-read, so it was left unchanged. Try again.');
    return stored.metadata || {};
}
