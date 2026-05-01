# Lessons

- Start non-trivial work in plan mode with a written checklist before implementation.
- Verify scalability claims against actual code paths, not just completed infrastructure work.
- Treat storage migration and query-path migration as separate milestones.
- Do not call the scalability work fully complete until the frontend no longer depends on heavy `MasterProperty` reads for route generation.
- When fixing route generation around drawn polygons, verify the fetch path actually runs in runtime logs; backend success alone does not prove the frontend passed the polygon state.
- For Neon route generation, audit the whole funnel: candidate fetch, merge behavior, and post-fetch filters. A successful Neon query can still produce zero routes if local filters drop imported records.
- If a critical UI panel fails with `Failed to fetch dynamically imported module`, prefer a direct import over retrying lazy imports so the panel cannot break on stale preview chunks.
- When removing a lazy import wrapper, update both the wrapper and every callsite import; otherwise the page bundle may still reference the stale dynamic path.
- If manager-generated routes must appear in the Knock tab immediately, save them assigned to the creator by default; unassigned routes are easy to miss in rep-facing route switchers.
- Avoid nesting interactive buttons inside route/property card buttons; use a clickable container with separate child buttons to prevent React DOM warnings and unreliable mobile taps.
- When changing mode-toggle behavior, verify the click handler updates the mode state itself; hiding panels without calling the mode setter makes the button appear broken.
- Before approving a Neon cutover, verify backfill pagination/count coverage; a dry-run or capped first-page backfill is not sufficient evidence that historical Base44 `MasterProperty` data is fully migrated.