# Canvas Phase 2 — Maryland HomeData Coverage and Dry-Run Report

## Decision state

The cohort result is accepted. This analysis does not change the frozen compiler, production classifier, property identities, roads, connectivity, workload, or partitioning. HomeData was downloaded once as a Montgomery County bulk slice, clipped to the frozen polygon offline, and never called by the runtime Canvas service.

No HomeData classification rule or production adapter is accepted yet.

## Source identity

- Official source: Maryland SDAT/MDP statewide Real Property Assessments
- Source dataset: `ed4q-f8tm`
- Official Montgomery County filtered view: `kb22-is2w`
- Portal-reported row update: `2026-08-05T22:25:30.000Z`
- License: Public Domain
- Selected polygon rows SHA-256: `bbd1b2feb161e95797f850fa9b70a711c08cee583c09c54652c6bbea922bde68`
- Provider calls: 0 BatchData, 0 RentCast, 0 paid calls, 0 per-property requests

The official bulk request returned 2,065 records for the benchmark bounding box. Exact polygon clipping retained 1,443 records.

## Conflation coverage

| Metric | Count |
|---|---:|
| HomeData records in frozen polygon | 1,443 |
| HomeData records matched to an existing FK_PROPERTY_ID | 1,138 |
| HomeData records with no candidate | 249 |
| Ambiguous HomeData records | 56 |
| Existing FirstKnock properties matched | 1,099 / 1,222 |
| Existing FirstKnock properties with no match | 123 |
| One-to-one FK property matches | 1,090 |
| One-to-many FK properties | 9 |
| HomeData records with multiple FK candidates | 56 |
| Exact normalized-address matches | 966 |
| Address matches with postal-city relaxation | 115 |
| Spatial-only matches | 57 |

Match confidence is 1,056 high, 82 medium, and 305 unmatched or ambiguous. Ambiguous rows never receive a supporting assertion.

The conflation order is deterministic: exact canonical number/street/unit/city/ZIP, then number/street/unit/ZIP with city relaxed and bounded spatial agreement, then unique spatial-only agreement within 15 meters. Ties with less than eight meters of separation remain ambiguous. HomeData does not create a new FK_PROPERTY_ID in this analysis.

## Review coverage

| Cohort | Total | Matched | Meaningful use evidence |
|---|---:|---:|---:|
| All reviews | 557 | 521 | 510 |
| Generic address + building reviews | 487 | 467 | 459 |

HomeData supplies a usable property-use assertion for 459 of the 487 dominant-cohort properties: 94.3% of that cohort.

## Actual source values and explicit mappings

Mappings use the descriptions delivered by SDAT/MDP, not guesses from field names or opaque numeric codes.

| Raw HomeData value | Polygon count | Normalized assertion | Proposed property type |
|---|---:|---|---|
| `Residential (R)` | 1,204 | residential | residential |
| `Residential Condominium (U)` | 132 | residential condominium | residential |
| `Apartments (M)` | 3 | apartments | multifamily |
| `Commercial (C)` | 7 | commercial | commercial |
| `Commercial Condominium (CC)` | 0 | commercial condominium | commercial |
| `Exempt Commercial (EC)` | 8 | exempt commercial | commercial |
| `Agricultural (A)` | 15 | agricultural | no classifier assertion yet |
| `Exempt (E)` | 74 | requires exempt-class detail | no unconditional assertion |

For `Exempt (E)`, only descriptive classes are proposed: public school → school; church/rectory/mosque/synagogue → religious; and explicitly described parks/public works/government/fire uses → government. `JUR Other`, housing-authority, cemetery, taxable-property, blank, and other unresolved classes remain unmapped.

The slice also contains explicit dwelling-type and building-style descriptions, dwelling-unit count, year built, structure area, tax class, county property code, public-use code, zoning, and owner-occupancy code. Dwelling descriptions are retained as supporting raw evidence, but they are not used to override the documented land-use value in this simulation. Opaque tax, county, public-use, and zoning codes remain unmapped until their official codebooks justify semantics. Owner occupancy is explicitly not treated as property use.

Every proposed assertion retains the raw land-use value, raw exempt class, account feature ID, dataset version, mapping basis, source identity, and Public Domain provenance.

## Conflict-safe dry run

### Current frozen result

- Eligible: 619
- Excluded: 46
- Review: 557 (45.6%)

### With proposed HomeData assertions

- Eligible: 1,098
- Excluded: 33
- Review: 91 (7.4%)

### Review movements

| Reason | Count |
|---|---:|
| HomeData residential evidence: review → eligible | 480 |
| HomeData commercial evidence: review → excluded | 1 |
| HomeData institutional/government evidence: review → excluded | 0 |
| Existing/HomeData use conflict: remains review | 22 |
| Still insufficient: remains review | 45 |
| Residential use but restricted access: remains review | 9 |

The 91 reviews also include 15 conservative control conflicts introduced by the new evidence: 14 currently excluded properties that HomeData describes as residential, and one currently eligible apartment property that HomeData describes as commercial. All 15 move to review in the simulation; HomeData does not override the existing evidence. The classifier reproduces the frozen baseline with zero parity mismatches when HomeData is omitted.

`propertyType` and `canvassEligibility` remain separate. Nine properties with residential use evidence remain review because access is restricted.

## Adapter decision

The source materially resolves the dominant cohort and would move the dry-run review rate below both the 15% and 10% targets while preserving conflicts. It therefore earns a production-adapter recommendation.

The next step, after review of this report, is a deterministic Maryland HomeData adapter with pinned source/version/hash, normalized assertion IDs, raw-value provenance, the mappings above, conflation versioning, and signed-compiler tests. The adapter must consume a bulk artifact offline; the runtime Canvas service must never call HomeData.