# Maryland durable build worker

This is a Railway background-worker image for the R2-authoritative Maryland evidence build. It is intentionally separate from the Canvas analysis API so API deploys and Base44 sessions do not own its lifecycle.

Configure the existing four `CANVAS_R2_*` credentials in the Railway service and deploy from the repository root with `services/maryland-build-worker/Dockerfile`. Railway should restart the process on failure. The worker validates all journal-referenced chunks, fully re-reads the last retained chunk, resumes `ed4q-f8tm` at the first missing offset, and commits each verified chunk through an immutable collision-safe state revision.

Read-only status:

```sh
node scripts/canvas-evidence/statewide/maryland-build-worker.mjs --status
```

One-chunk acceptance run:

```sh
node scripts/canvas-evidence/statewide/maryland-build-worker.mjs --once
```

The current image completes phase 04 only. It fails closed after HomeData rather than guessing the lost statewide partition orchestration; the frozen compiler is not modified.