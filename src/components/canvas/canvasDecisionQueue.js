import localforage from 'localforage';

const decisionQueue = localforage.createInstance({
  name: 'firstknock-canvas',
  storeName: 'canvas_decision_queue_v2',
  description: 'Isolated Canvas-only pending house decisions.',
});

function actorScope({ actorUserId, assignedTeamMemberId } = {}) {
  const userId = String(actorUserId || '').trim();
  if (!userId) throw new Error('The signed-in Canvas user is required for offline decisions.');
  return `${userId}:${String(assignedTeamMemberId || '').trim()}`;
}

function queueKey(decision) {
  const idempotencyKey = String(decision?.idempotencyKey || '').trim();
  if (!idempotencyKey) throw new Error('Canvas decision idempotency key is required.');
  return `${actorScope(decision)}:${idempotencyKey}`;
}

export async function queueCanvasDecision(decision) {
  const key = queueKey(decision);
  const queued = {
    ...decision,
    actorUserId: String(decision.actorUserId),
    assignedTeamMemberId: String(decision.assignedTeamMemberId || ''),
    queuedAt: decision.queuedAt || new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
  };
  await decisionQueue.setItem(key, queued);
  return queued;
}

export function acknowledgeCanvasDecision(decision) {
  return decisionQueue.removeItem(queueKey(decision));
}

export async function listQueuedCanvasDecisions({ actorUserId, assignedTeamMemberId, campaignId, zoneId } = {}) {
  const scope = actorScope({ actorUserId, assignedTeamMemberId });
  const decisions = [];
  await decisionQueue.iterate((value) => {
    if (!value) return;
    try {
      if (actorScope(value) !== scope) return;
    } catch {
      return;
    }
    if (campaignId && String(value.campaignId) !== String(campaignId)) return;
    if (zoneId && String(value.zoneId) !== String(zoneId)) return;
    decisions.push(value);
  });
  return decisions.sort((left, right) => String(left.queuedAt).localeCompare(String(right.queuedAt)));
}
