import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

function items(result) {
  return Array.isArray(result) ? result : (result?.items || []);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

async function pagedFilter(entity, query, pageSize = 500) {
  const all = [];
  for (let skip = 0; skip < 10000; skip += pageSize) {
    const page = items(await entity.filter(query, '-created_date', pageSize, skip));
    all.push(...page);
    if (page.length < pageSize) return all;
  }
  throw new Error('Referral query exceeded the supported tracking limit.');
}

async function makeUniqueCode(base44, user) {
  const namePart = (user.full_name || 'RYAN').replace(/[^a-zA-Z]/g, '').slice(0, 5).toUpperCase() || 'RYAN';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
    const code = `FK-${namePart}-${suffix}`;
    const match = items(await base44.asServiceRole.entities.AffiliateProfile.filter({ referral_code: code }, '-created_date', 1));
    if (!match[0]) return code;
  }
  throw new Error('Unable to generate a unique referral code.');
}

async function ensureProfile(base44, user) {
  const existing = items(await base44.asServiceRole.entities.AffiliateProfile.filter(
    { owner_user_id: user.id },
    '-created_date',
    1
  ));
  if (existing[0]) return existing[0];

  const legacyCode = normalizeCode(user.referral_code);
  const legacyMatch = legacyCode
    ? items(await base44.asServiceRole.entities.AffiliateProfile.filter({ referral_code: legacyCode }, '-created_date', 1))
    : [];
  const referralCode = legacyCode && !legacyMatch[0] ? legacyCode : await makeUniqueCode(base44, user);
  const profile = await base44.asServiceRole.entities.AffiliateProfile.create({
    owner_user_id: user.id,
    owner_email: normalizeEmail(user.email),
    owner_name: user.full_name || normalizeEmail(user.email),
    referral_code: referralCode,
    program: 'volume_partner',
    base_rate_pct: 10,
    threshold_active_customers: 50,
    qualified_rate_pct: 25,
    status: 'active'
  });
  if (user.referral_code !== referralCode) {
    await base44.asServiceRole.entities.User.update(user.id, { referral_code: referralCode });
  }
  return profile;
}

async function getPartnerReferrals(base44, user) {
  const byId = await pagedFilter(base44.asServiceRole.entities.Referral, { referrer_user_id: user.id });
  const legacy = await pagedFilter(base44.asServiceRole.entities.Referral, { referrer_email: normalizeEmail(user.email) });
  return [...new Map([...byId, ...legacy].map((record) => [record.id, record])).values()];
}

async function getPartnerCommissions(base44, user) {
  const byId = await pagedFilter(base44.asServiceRole.entities.ReferralCommission, { referrer_user_id: user.id });
  const legacy = await pagedFilter(base44.asServiceRole.entities.ReferralCommission, { referrer_email: normalizeEmail(user.email) });
  return [...new Map([...byId, ...legacy].map((record) => [record.id, record])).values()];
}

async function getReferredUsers(base44, referrals) {
  const wantedIds = new Set(referrals.map((referral) => referral.referred_user_id).filter(Boolean));
  const wantedEmails = new Set(referrals.map((referral) => normalizeEmail(referral.referred_email)).filter(Boolean));
  const matched = new Map();
  for (let skip = 0; skip < 10000 && matched.size < referrals.length; skip += 500) {
    const page = items(await base44.asServiceRole.entities.User.list('-created_date', 500, skip));
    for (const account of page) {
      if (wantedIds.has(account.id) || wantedEmails.has(normalizeEmail(account.email))) {
        matched.set(account.id, account);
        matched.set(normalizeEmail(account.email), account);
      }
    }
    if (page.length < 500) break;
  }
  return matched;
}

function calculateCommissionStats(profile, commissions, activeCustomers) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const byMonth = new Map();
  for (const entry of commissions) {
    const month = entry.commission_month || String(entry.paid_at || '').slice(0, 7);
    if (!month) continue;
    if (!byMonth.has(month)) byMonth.set(month, { revenueCents: 0, customers: new Set(), unpaidCents: 0 });
    const group = byMonth.get(month);
    group.revenueCents += Number(entry.revenue_cents || 0);
    group.customers.add(entry.referred_user_id || normalizeEmail(entry.referred_email));
    if (entry.payout_status !== 'paid') group.unpaidCents += Number(entry.revenue_cents || 0);
  }

  let totalEarnedCents = 0;
  let balanceCents = 0;
  let currentMonthRevenueCents = 0;
  let currentMonthCommissionCents = 0;
  const threshold = Number(profile.threshold_active_customers || 50);
  const baseRate = Number(profile.base_rate_pct || 10);
  const qualifiedRate = Number(profile.qualified_rate_pct || 25);

  for (const [month, group] of byMonth) {
    const qualifyingCount = month === currentMonth ? activeCustomers : group.customers.size;
    const rate = qualifyingCount >= threshold ? qualifiedRate : baseRate;
    const earned = Math.round(group.revenueCents * rate / 100);
    const unpaid = Math.round(group.unpaidCents * rate / 100);
    totalEarnedCents += earned;
    balanceCents += unpaid;
    if (month === currentMonth) {
      currentMonthRevenueCents = group.revenueCents;
      currentMonthCommissionCents = earned;
    }
  }

  const currentRate = activeCustomers >= threshold ? qualifiedRate : baseRate;
  return {
    balance: balanceCents / 100,
    total_earned: totalEarnedCents / 100,
    current_rate_pct: currentRate,
    current_month_revenue: currentMonthRevenueCents / 100,
    current_month_commission: currentMonthCommissionCents / 100,
    active_customers: activeCustomers,
    threshold_active_customers: threshold,
    customers_to_qualified_rate: Math.max(0, threshold - activeCustomers)
  };
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const action = body.action;

    if (action === 'generate_code') {
      const profile = await ensureProfile(base44, user);
      return Response.json({ referral_code: profile.referral_code });
    }

    if (action === 'apply_code') {
      const referralCode = normalizeCode(body.referral_code);
      if (!referralCode) return Response.json({ error: 'No referral code provided' }, { status: 400 });

      const profiles = items(await base44.asServiceRole.entities.AffiliateProfile.filter(
        { referral_code: referralCode, status: 'active' },
        '-created_date',
        1
      ));
      const profile = profiles[0];
      if (!profile) return Response.json({ error: 'Invalid referral code' }, { status: 404 });
      if (profile.owner_user_id === user.id) return Response.json({ error: 'Cannot use your own referral code' }, { status: 400 });

      const existingById = items(await base44.asServiceRole.entities.Referral.filter({ referred_user_id: user.id }, '-created_date', 1));
      const existingByEmail = items(await base44.asServiceRole.entities.Referral.filter({ referred_email: normalizeEmail(user.email) }, '-created_date', 1));
      if (existingById[0] || existingByEmail[0]) {
        return Response.json({ error: 'You already used a referral code', already_applied: true });
      }

      await base44.asServiceRole.entities.Referral.create({
        referrer_user_id: profile.owner_user_id,
        referrer_email: profile.owner_email,
        referred_user_id: user.id,
        referred_email: normalizeEmail(user.email),
        referred_name: user.full_name || normalizeEmail(user.email).split('@')[0],
        referral_code: referralCode,
        status: 'signed_up',
        commission_amount: 0
      });
      await base44.asServiceRole.entities.User.update(user.id, { referred_by_code: referralCode });
      return Response.json({ success: true, referrer_name: profile.owner_name });
    }

    if (action === 'get_stats') {
      const profile = await ensureProfile(base44, user);
      const referrals = await getPartnerReferrals(base44, user);
      const commissions = await getPartnerCommissions(base44, user);
      const accountMap = await getReferredUsers(base44, referrals);
      const activeCustomers = new Set(referrals.filter((referral) => {
        const account = accountMap.get(referral.referred_user_id) || accountMap.get(normalizeEmail(referral.referred_email));
        return account?.subscription_status === 'active' && account?.subscription_paid_confirmed === true;
      }).map((referral) => referral.referred_user_id || normalizeEmail(referral.referred_email))).size;
      const money = calculateCommissionStats(profile, commissions, activeCustomers);

      return Response.json({
        referral_code: profile.referral_code,
        referral_link: `${body.origin || 'https://firstknock.online'}/RoleSelect?ref=${encodeURIComponent(profile.referral_code)}`,
        ...money,
        referrals: referrals.map((referral) => {
          const account = accountMap.get(referral.referred_user_id) || accountMap.get(normalizeEmail(referral.referred_email));
          const subscribed = account?.subscription_status === 'active' && account?.subscription_paid_confirmed === true;
          return {
            id: referral.id,
            referred_name: referral.referred_name,
            referred_email: referral.referred_email,
            status: subscribed ? 'subscribed' : referral.status,
            commission_amount: referral.commission_amount || 0,
            created_date: referral.created_date,
            paid_out_date: referral.paid_out_date
          };
        }),
        total_referrals: referrals.length,
        signed_up: referrals.length - activeCustomers,
        subscribed: activeCustomers
      });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('[Referral] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}