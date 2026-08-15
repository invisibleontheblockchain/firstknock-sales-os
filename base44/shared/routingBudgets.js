// The single place every route-sizing limit is defined.
//
// Requirement from Stage 2 review: 1,000, 240, 250 and friends must not be
// scattered across modules where one can be retuned and the others forgotten.
// Anything that decides "is this route small enough" imports from here.
//
// Two budgets, two owners:
//   - MAX_HOMES_PER_ROUTE is a PRODUCT decision. Hard ceiling.
//   - the matrix-point budget is a TECHNICAL consequence of the road matrix
//     implementation, so it is DERIVED from MAX_ROUTE_MATRIX_POINTS rather than
//     restated as a second literal.

import { MAX_ROUTE_MATRIX_POINTS } from './roadMatrix.js';

// Hard operator-facing ceiling. A route may never exceed this.
export const MAX_HOMES_PER_ROUTE = 1000;

// Acceptable spread BETWEEN routes when balancing — a preference, never a
// budget. Historically 1200 leaked into `routingUnitWorkload` as the door
// budget, which let the model propose 1,143-home routes: above the product cap.
// Balance may move a route within this band; it may never push it past
// MAX_HOMES_PER_ROUTE.
export const HOMES_PER_ROUTE_BALANCE_BAND = Object.freeze({ min: 800, max: 1200 });

// A bounded trip prices a start and a finish alongside the doors.
export const ROUTE_ANCHOR_ALLOWANCE = 2;

// Headroom below the raw matrix limit. Blocks are counted from canonical street
// keys before the matrix de-duplicates identical coordinates, and a partition
// can gain a block when a cut lands on a street. Spending the last few points
// would turn any such drift into a tier downgrade, which is the silent
// degradation Stage 2 exists to remove.
export const MATRIX_POINT_HEADROOM = 8;

/**
 * How many street blocks one route may contain and still be priced at block
 * tier or better.
 *
 * IMPORTANT: the currency here is STREET BLOCKS, not routing units. The road
 * matrix carries one representative point per block (`planTieredRoadMatrix`),
 * while a protected pocket is a single routing unit that can span several
 * blocks. Budgeting 240 *units* would therefore allow a route whose block count
 * exceeds the matrix limit and silently drops to cluster tier. Pockets stay
 * atomic in the partitioner; the budget is checked in blocks.
 *
 * 240 at today's values (250 - 2 anchors - 8 headroom). If
 * MAX_ROUTE_MATRIX_POINTS changes, this follows automatically.
 */
export const MAX_BLOCKS_PER_ROUTE = MAX_ROUTE_MATRIX_POINTS
    - ROUTE_ANCHOR_ALLOWANCE
    - MATRIX_POINT_HEADROOM;

export const ROUTING_BUDGETS = Object.freeze({
    maxHomesPerRoute: MAX_HOMES_PER_ROUTE,
    maxBlocksPerRoute: MAX_BLOCKS_PER_ROUTE,
    balanceBand: HOMES_PER_ROUTE_BALANCE_BAND,
    anchorAllowance: ROUTE_ANCHOR_ALLOWANCE,
    matrixPointLimit: MAX_ROUTE_MATRIX_POINTS
});