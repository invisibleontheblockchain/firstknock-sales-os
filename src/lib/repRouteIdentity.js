import { isManagerAccount } from './roles.js';

const field = (user, name) => user?.[name] || user?.data?.[name];
export function repRouteIdentityNeedsClaim(user) {
  return !!user?.id && !isManagerAccount(user) && !field(user, 'team_member_id');
}
export async function ensureRepRouteIdentity(client, user) {
  if (!repRouteIdentityNeedsClaim(user)) return user;
  await client.functions.invoke('redeemInviteCode', { action: 'claim_existing' });
  const verified = await client.auth.me();
  const managerId = field(user, 'team_manager_id');
  if (verified?.id !== user.id || isManagerAccount(verified) || !field(verified, 'team_member_id')
      || !field(verified, 'team_manager_id') || (managerId && field(verified, 'team_manager_id') !== managerId)) {
    throw new Error('Your team membership could not be verified.');
  }
  return verified;
}
