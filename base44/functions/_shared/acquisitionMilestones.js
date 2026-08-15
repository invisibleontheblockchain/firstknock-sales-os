function asArray(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function safeId(value, fallback = 'unknown') {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64) || fallback;
}

async function hashedIdentifier(kind, value) {
  const bytes = new TextEncoder().encode(`${kind}:${String(value || '')}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${kind}_${hex.slice(0, 48)}`;
}

function touchFor(user, manager) {
  return manager?.acquisition_first_touch
    || user?.acquisition_first_touch
    || {};
}

export async function writeAcquisitionMilestone(service, {
  eventName,
  eventKey,
  user,
  manager = null,
  workspaceManagerId = null,
  evidenceId = '',
  occurredAt = new Date().toISOString(),
} = {}) {
  try {
    const entity = service?.entities?.AcquisitionEvent;
    if (!entity?.filter || !entity?.create || !user?.id || !eventName || !eventKey) {
      return null;
    }
    const eventId = safeId(eventKey).slice(0, 80);
    const existing = asArray(
      await entity.filter({ event_id: eventId }, '-created_date', 1),
    );
    if (existing.length) return existing[0];

    const subject = safeId(user.id);
    const managerId = safeId(workspaceManagerId || manager?.id || user.id);
    const touch = touchFor(user, manager);
    return await entity.create({
      event_id: eventId,
      event_name: eventName,
      anonymous_id: await hashedIdentifier('account', subject),
      session_id: await hashedIdentifier('server', eventId),
      user_id: user.id,
      workspace_manager_id: workspaceManagerId || manager?.id || user.id,
      source: touch.source || 'unknown',
      medium: touch.medium || 'unknown',
      campaign: touch.campaign || 'unassigned',
      content: touch.content || 'unassigned',
      term: touch.term || '',
      landing_path: touch.landing_path || '/',
      referrer_host: touch.referrer_host || '',
      cta_variant: '',
      occurred_at: occurredAt,
      is_authenticated: true,
      trust_source: 'trusted_product_function',
      evidence_id: String(evidenceId || managerId).slice(0, 160),
    });
  } catch (error) {
    console.warn(
      '[AcquisitionMilestone] event write skipped',
      error?.message || error,
    );
    return null;
  }
}
