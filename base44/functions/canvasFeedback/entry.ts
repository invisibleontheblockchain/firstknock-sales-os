import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const ALLOWED_FEEDBACK = new Set(['looks_correct', 'looks_incorrect']);

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { analysisId, feedback, notes, self_test } = await req.json();
    if (self_test) {
      return Response.json({ success: true, mode: 'self_test', service: 'canvasFeedback' });
    }
    if (!analysisId || !ALLOWED_FEEDBACK.has(feedback)) {
      return Response.json({ error: 'analysisId and valid feedback are required' }, { status: 400 });
    }

    const databaseUrl = Deno.env.get('DATABASE_URL');
    if (!databaseUrl) {
      return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });
    }

    const sql = neon(databaseUrl);
    const rows = await sql`
      UPDATE canvas_analysis
      SET manager_feedback = ${feedback}, feedback_notes = ${notes || null}, updated_at = NOW()
      WHERE id = ${analysisId}
      RETURNING id, manager_feedback, feedback_notes, updated_at
    `;

    if (!rows.length) {
      return Response.json({ error: 'Analysis not found' }, { status: 404 });
    }

    return Response.json({ success: true, feedback: rows[0] });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});