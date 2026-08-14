function items(result) {
  return Array.isArray(result) ? result : (result?.items || []);
}

export async function recordReferralInvoice(base44, user, subscription, invoice) {
  const invoiceId = String(invoice?.id || '');
  const revenueCents = Number(invoice?.amount_paid || 0);
  if (!user?.id || !invoiceId || !Number.isInteger(revenueCents) || revenueCents <= 0) return null;

  const existing = items(await base44.asServiceRole.entities.ReferralCommission.filter(
    { stripe_invoice_id: invoiceId },
    '-created_date',
    1
  ));
  if (existing[0]) return existing[0];

  let referrals = items(await base44.asServiceRole.entities.Referral.filter(
    { referred_user_id: user.id },
    '-created_date',
    1
  ));
  if (!referrals[0] && user.email) {
    referrals = items(await base44.asServiceRole.entities.Referral.filter(
      { referred_email: String(user.email).trim().toLowerCase() },
      '-created_date',
      1
    ));
  }
  const referral = referrals[0];
  if (!referral?.referrer_user_id) return null;

  const paidSeconds = Number(invoice?.status_transitions?.paid_at || invoice?.created || 0);
  const paidAt = paidSeconds > 0 ? new Date(paidSeconds * 1000) : new Date();
  return await base44.asServiceRole.entities.ReferralCommission.create({
    referrer_user_id: referral.referrer_user_id,
    referrer_email: String(referral.referrer_email || '').trim().toLowerCase(),
    referred_user_id: user.id,
    referred_email: String(user.email || referral.referred_email || '').trim().toLowerCase(),
    referral_id: referral.id,
    referral_code: referral.referral_code,
    stripe_invoice_id: invoiceId,
    stripe_subscription_id: subscription?.id || null,
    revenue_cents: revenueCents,
    currency: String(invoice?.currency || 'usd').toLowerCase(),
    paid_at: paidAt.toISOString(),
    commission_month: paidAt.toISOString().slice(0, 7),
    payout_status: 'unpaid'
  });
}