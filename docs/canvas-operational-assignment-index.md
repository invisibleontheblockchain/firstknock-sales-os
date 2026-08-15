# Canvas operational assignment index

`canvasGetAssignmentIndex` is the bounded discovery endpoint for production residential Canvas assignments. It replaces the residential path that scanned and verified full `CanvasSession` lifecycle records. Precision routes and legacy Canvas campaigns remain outside this endpoint.

The function is POST-only and accepts an optional body:

```json
{
  "limit": 50,
  "cursor": "canvas_assignment_previous-id"
}
```

`limit` is capped at 100. Continue while `has_more` is true, passing `next_cursor` verbatim. The server resolves the signed-in user to exactly one active rep `TeamMember`, then queries only `CANVAS_DATABASE_URL`. Rows must match that exact manager, user, and team-member identity; the deployment, assignment, and package must all be active/current/ready and unexpired.

The response is deliberately a small package-discovery index:

```json
{
  "success": true,
  "schema": "firstknock.canvas-assignment-index",
  "schema_version": 1,
  "assignments": [
    {
      "assignment_id": "canvas_assignment_...",
      "package_id": "canvas_package_...",
      "package_version": 3,
      "manifest_hash": "<sha256>",
      "valid_until": "2026-08-21T12:00:00.000Z",
      "campaign_id": "canvas-session-id",
      "zone_id": "canvas-residential-zone:7",
      "assignment_index_version": 4
    }
  ],
  "has_more": false,
  "next_cursor": null,
  "server_time": "2026-08-14T12:00:00.000Z"
}
```

`package_version` is the current package version. `valid_until` is the earlier of the assignment and package expiries. The endpoint intentionally does not store or return campaign names, territory names, colors, geometry, streets, opportunities, pins, or DNC entries. Those are either presentation-only metadata or signed package artifacts. Until presentation metadata is normalized separately, the client should use the neutral labels **Canvas area** and **Territory**; it must not fall back to loading a full `CanvasSession` for residential assignment discovery.

The complete current index is authoritative. After all pages are fetched successfully, the client may tombstone cached residential assignments that are absent. It must retain the last verified local index when the network request fails or when pagination does not complete.
