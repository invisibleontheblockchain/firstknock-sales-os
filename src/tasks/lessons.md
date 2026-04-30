# Lessons

- Start non-trivial work in plan mode with a written checklist before implementation.
- Verify scalability claims against actual code paths, not just completed infrastructure work.
- Treat storage migration and query-path migration as separate milestones.
- Do not call the scalability work fully complete until the frontend no longer depends on heavy `MasterProperty` reads for route generation.