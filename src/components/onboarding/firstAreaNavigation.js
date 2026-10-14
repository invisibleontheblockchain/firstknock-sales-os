export function getInitialMapMode(search) {
  const params = new URLSearchParams(search);
  return params.get('startDraw') === 'true' || params.get('onboarding') === 'precision'
    ? 'generate'
    : 'analyze';
}

// Claim the handoff only after generation succeeds. Persist it so a refresh
// during the walkthrough cannot make later generations reopen Route Command.
export function claimFirstAreaRouteHandoff(user, storage) {
  if (!user?.id || user.app_role !== 'manager' || user.has_seen_onboarding) return false;
  const walkthroughKey = `fk_firstAreaWalkthrough_${user.id}`;
  const handoffKey = `fk_firstAreaRouteOpened_${user.id}`;
  if (storage.getItem(walkthroughKey) !== 'active' || storage.getItem(handoffKey) === 'true') return false;
  storage.setItem(handoffKey, 'true');
  return true;
}
