# Canvas Phase 2 — Frozen Review Cohort Report

## Scope and non-goals

This report profiles the frozen Damascus Benchmark v2 review set. It does not modify property identities, source evidence, classification rules, signed roads, workload, or territory partitioning.

## Baseline

| Metric | Count | Percent |
|---|---:|---:|
| Canonical properties | 1,222 | 100% |
| Eligible | 619 | 50.7% |
| Excluded | 46 | 3.8% |
| Review | 557 | 45.6% |
| Unresolved property use | 526 | 43.0% of all / 94.4% of review |
| Automatically resolved | 665 | 54.4% |

## Signal coverage across all 557 reviews

| Signal | Properties |
|---|---:|
| Normalized address | 557 |
| Building linkage | 527 |
| Overture building evidence | 527 |
| Generic `building=yes` | 516 |
| Nearby typed residential building | 38 |
| Residential land-use context | 21 |
| Commercial POI context | 21 |
| Conflicting use evidence | 21 |
| Restricted or unknown access | 9 |
| OSM building assertion in signed property evidence | 0 |
| Assessor/parcel evidence | 0 |
| Multifamily indicator | 0 |

## Dominant evidence combinations

| Count | % review | Combination |
|---:|---:|---|
| 487 | 87.4% | address + generic Overture building + no land-use + no POI + no nearby typed residential building + clear access + no conflict |
| 19 | 3.4% | address + no building linkage + no land-use + no POI + no nearby typed residential building + clear access + no conflict |
| 11 | 2.0% | address + generic building + residential land-use + commercial POI + no nearby typed residential building + conflict |
| 10 | 1.8% | address + generic building + residential land-use + commercial POI + 2+ nearby typed residential buildings + conflict |
| 10 | 1.8% | address + no building linkage + no land-use/POI + one nearby typed residential building |
| 7 | 1.3% | address + generic building + no land-use/POI + one nearby typed residential building |
| 7 | 1.3% | address + typed residential building + 2+ nearby typed residential buildings + restricted access |
| 2 | 0.4% | address + typed residential building + one nearby typed residential building + restricted access |
| 1 | 0.2% | address + generic building + 2+ nearby typed residential buildings + clear access |
| 1 | 0.2% | address + no building linkage + 2+ nearby typed residential buildings + clear access |
| 1 | 0.2% | address + Overture-linked building with no usable type/context |
| 1 | 0.2% | address + typed residential building + no nearby typed residential building + clear access |

Representative dominant-cohort records include 9713 Greenel Road, 9712 Greenel Road, and 9502 Greenel Road. The only property reached by the tested generic-building plus two-neighbor rule was 9342 Hawkins Creamery Road.

## Proposed-rule counterfactuals

No proposed rule is accepted yet.

### P2-R1 — residential land-use reinforcement

- Required evidence: valid address + generic physical building + residential land-use + no commercial/institutional or access conflict
- Reviews resolved: 0
- Eligible/excluded change: +0 / +0
- Confidence rationale: address, structure, and polygonal residential context would agree
- False-positive risk: low-to-moderate because residential polygons can contain accessory or non-residential structures
- Scope: national

### P2-R2 — neighboring typed residences

- Required evidence: valid address + generic physical building + at least two nearby explicitly residential buildings + no conflict
- Reviews resolved: 1
- Eligible/excluded change: +1 / +0
- Confidence rationale: address and physical structure are reinforced by independently typed nearby structures
- False-positive risk: moderate at mixed-use edges, campuses, farms, and parcel boundaries; nearby context is not parcel identity
- Scope: national

### P2-R3 — non-residential agreement

- Required evidence: valid address + physical building + matching commercial/institutional POI or land-use exclusion
- Reviews resolved: 0
- Eligible/excluded change: +0 / +0
- Confidence rationale: address, structure, and non-residential context would agree
- False-positive risk: moderate unless the POI/land-use overlaps the property rather than merely being nearby
- Scope: national

## Free/bulk evidence findings

### Existing Overture buildings

Of 495 inspected building records linked to unresolved reviews, 494 have null `class`, 494 have null `subtype`, and 494 have no floor count. Height is commonly present but does not establish occupancy. Overture therefore supplies strong physical-building evidence but not a safe use classification for the dominant cohort.

### Existing OSM extract

The raw extract contains 689 building features, including 215 `house`, 99 `terrace`, 3 `apartments`, and 310 generic `yes` features. Exact point-in-footprint matching over the 526 unresolved records finds 73 generic `building=yes`, one `farm_auxiliary`, and no explicitly residential building tag; 447 have no exact OSM context match. At 75 meters, only seven unresolved properties have two or more typed residential buildings nearby. This is useful supporting evidence but cannot resolve the dominant cohort by itself.

The signed property assertions currently contain no OSM building assertion. Adding OSM building polygons to the offline evidence contract is nationally applicable, but Damascus coverage indicates limited immediate gain and provenance must avoid treating Overture records sourced from OSM as independent corroboration.

### National Address Database

USDOT NAD is a free bulk identity/coordinate source. Its published purpose and schema support authoritative address presence, not residential-versus-business occupancy. It can improve address coverage and conflation but cannot safely resolve property use alone.

### Overture base land use and places

These are free national bulk themes and remain useful context. Existing Damascus coverage produces only 21 residential-land-use/commercial-POI conflicts and no safe unresolved-use resolution. Context must remain separate from property identity.

### OpenBuildingMap

OpenBuildingMap is ODbL bulk data with occupancy classifications for approximately 39% of its global buildings. It is a promising national supplemental source, but occupancy is inferred partly from OSM land use/POIs and machine-learning inputs. It should be benchmarked against authoritative assessor classes before becoming high-confidence evidence and must not be counted as independent when it derives from the same OSM/Microsoft inputs already present.

### Maryland SDAT/MDP HomeData

Maryland's free statewide HomeData dataset exposes 181 fields, including coordinates, street address, `Land Use Code`, year built, dwelling-unit count, and structure area. This is the highest-value Phase 2 candidate for Maryland because it supplies authoritative use and dwelling evidence in one bulk dataset. The portal's record endpoint was blocked by Cloudflare in this environment, so no coverage claim is made; integration should use an official bulk export, never per-property runtime requests.

### Parcels and Census

Maryland and Montgomery County publish parcel layers suitable for deterministic offline spatial joins. Parcel geometry alone does not prove use, but parcel plus SDAT use is strong Maryland-specific evidence. Census housing units remain calibration/coverage evidence only and must not create or classify individual properties.

## Decision and next step

The current frozen evidence responsibly supports no broad classifier rule: P2-R1 and P2-R3 resolve zero records, while P2-R2 resolves one with moderate risk. The next coherent iteration is an offline Maryland HomeData bulk join using normalized address plus bounded spatial agreement, followed by a per-land-use-code conflict audit against the frozen 619 eligible and 46 excluded controls. No classifier threshold should change until that audit reports coverage, conflicts, reason codes, samples, and deterministic rebuild hashes.

Sources: Overture Buildings schema, USDOT National Address Database, Maryland Open Data HomeData/parcel resources, Montgomery Planning GIS downloads, and OpenBuildingMap's published ODbL dataset documentation.