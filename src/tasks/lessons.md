# Lessons

- Start non-trivial work in plan mode with a written checklist before implementation.
- Verify scalability claims against actual code paths, not just completed infrastructure work.
- Treat storage migration and query-path migration as separate milestones.
- Do not call the scalability work fully complete until the frontend no longer depends on heavy `MasterProperty` reads for route generation.
- When fixing route generation around drawn polygons, verify the fetch path actually runs in runtime logs; backend success alone does not prove the frontend passed the polygon state.
- For Neon route generation, audit the whole funnel: candidate fetch, merge behavior, and post-fetch filters. A successful Neon query can still produce zero routes if local filters drop imported records.