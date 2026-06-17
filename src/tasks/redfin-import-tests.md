# Redfin CSV Import-to-Route Verification

Status: Implementation complete; in-app interaction verification still open.

- [x] TEST 1: Code-verified all three attached Redfin CSVs auto-detect as Redfin and silently skip the disclaimer row (ready counts: 195, 103, 173 from 196, 104, 174 parsed rows).
- [x] TEST 2: Code-verified ZIP strings without decimals, `March-19-2026` → `2026-03-19`, missing numeric values normalize to null, and raw metadata is preserved.
- [x] TEST 3: Code-verified non-Redfin CSV detection returns false/null so existing fallback behavior remains available.
- [ ] TEST 4: In-app upload required: confirm summary screen shows correct counts and both buttons.
- [ ] TEST 5: In-app Create Route required: confirm pins render on Leaflet map, route name is filename-derived, and metadata.source = redfin_csv.
- [ ] TEST 6: In-app Cancel required: confirm no data is saved.
- [ ] TEST 7: In-app Split Route required: confirm modal works on imported Redfin route.
- [ ] TEST 8: In-app export required: confirm route CSV export contains route stops.
- [ ] TEST 9: In-app Knock Mode required: confirm assignment and “Re-optimize from here” behavior.
- [x] TEST 10: Code-verified >1,000-row Redfin CSV shows the exact required error and does not proceed.
- [ ] TEST 11: In-app/geocoding-network required: confirm address-only rows geocode and appear on map.
- [ ] TEST 12: Code/build-verified Builder Mode Import CSV button is present and opens the shared upload flow; visual in-app confirmation still recommended.