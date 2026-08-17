# Canvas source artifact retention

Every production evidence release must start from a checked-in source manifest and immutable bulk artifacts in R2/S3. Raw PBF, GeoJSON, and bulk assessor exports never belong in Git.

A source manifest pins origin, license, source version, extraction geometry and predicates, tool/reader options, transformation versions, object key, byte length, SHA-256, canonical content hash where applicable, and raw record count. Object keys are append-only and versioned; overwrite is forbidden.

Before compilation, mirror the listed objects into an empty local directory and run `npm run canvas:sources:verify -- <manifest> <artifact-root>`. Missing bytes, altered bytes, changed canonical content, incomplete provenance, or duplicate source IDs fail closed. Uploads must be re-read and hash-verified before a signed evidence manifest is published.