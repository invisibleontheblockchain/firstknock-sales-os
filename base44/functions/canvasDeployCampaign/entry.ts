// DISABLED 2026-08-16 — deliberately replaced with a fail-closed stub.
//
// The deployed copy of this function was 3,131 lines against main's 3,472 and was missing the
// signed-evidence gate entirely: verifyResidentialEvidenceForDeploy (2 occurrences on main),
// legacy_canvas_evidence_required (1) and CANVAS_ALLOW_PUBLIC_OVERPASS_FALLBACK (1) were all
// absent. Its verifyServerTopology therefore verified territories against public Overpass as a
// primary source and then signed the campaign active, so a pre-existing draft could have been
// activated on unverified street data by an authenticated manager.
//
// The authoritative 3,472-line implementation lives on main at
// base44/functions/canvasDeployCampaign/entry.ts. Restore it via a server-side repo sync.
// Do NOT hand-reconstruct the missing logic here, and do NOT extract shared helpers into
// base44/shared/ — test/canvas-operational-api.test.mjs:25 requires every Canvas function to
// remain self-contained (doesNotMatch(/from ['"]\.\.?\//)).

Deno.serve(() => {
  return Response.json({
    error: "canvas_deploy_disabled",
    message: "Canvas campaign deployment is disabled pending a source sync. Nothing was deployed."
  }, { status: 503 });
});