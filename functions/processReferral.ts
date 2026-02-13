import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const FLAT_COMMISSION = 10; // $10 per referral, regardless of plan

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { action } = body;

    // ACTION: Generate a referral code for the current user
    if (action === 'generate_code') {
      if (user.referral_code) {
        return Response.json({ referral_code: user.referral_code });
      }
      // Generate a unique code: FK-<first 4 chars of name>-<random 5>
      const namePart = (user.full_name || 'USER').replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase();
      const randPart = Math.random().toString(36).substring(2, 7).toUpperCase();
      const code = `FK-${namePart}-${randPart}`;

      await base44.asServiceRole.entities.User.update(user.id, { referral_code: code });
      return Response.json({ referral_code: code });
    }

    // ACTION: Apply a referral code during signup (called by the new user)
    if (action === 'apply_code') {
      const { referral_code } = body;
      if (!referral_code) {
        return Response.json({ error: 'No referral code provided' }, { status: 400 });
      }

      // Don't let user refer themselves
      if (user.referral_code === referral_code) {
        return Response.json({ error: 'Cannot use your own referral code' }, { status: 400 });
      }

      // Already used a referral code
      if (user.referred_by_code) {
        return Response.json({ error: 'You already used a referral code', already_applied: true });
      }

      // Find the referrer by code
      const allUsers = await base44.asServiceRole.entities.User.list('-created_date', 5000);
      const users = Array.isArray(allUsers) ? allUsers : (allUsers?.items || []);
      const referrer = users.find(u => u.referral_code === referral_code);

      if (!referrer) {
        return Response.json({ error: 'Invalid referral code' }, { status: 404 });
      }

      // Save referred_by_code on the new user
      await base44.asServiceRole.entities.User.update(user.id, { referred_by_code: referral_code });

      // Create referral record
      await base44.asServiceRole.entities.Referral.create({
        referrer_email: referrer.email,
        referred_email: user.email,
        referred_name: user.full_name || user.email.split('@')[0],
        referral_code: referral_code,
        status: 'signed_up',
        commission_amount: 0,
      });

      console.log(`[Referral] ${user.email} signed up via ${referrer.email}'s code ${referral_code}`);
      return Response.json({ success: true, referrer_name: referrer.full_name });
    }

    // ACTION: Credit commission when a referred user subscribes (called from stripe webhook)
    if (action === 'credit_commission') {
      // Admin only
      if (user.role !== 'admin') {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }

      const { referred_email, subscription_tier } = body;
      if (!referred_email || !subscription_tier) {
        return Response.json({ error: 'Missing params' }, { status: 400 });
      }

      const commission = FLAT_COMMISSION;

      // Find the referral record
      const referrals = await base44.asServiceRole.entities.Referral.filter(
        { referred_email },
        '-created_date',
        1
      );
      const refList = Array.isArray(referrals) ? referrals : (referrals?.items || []);
      const referral = refList[0];

      if (!referral) {
        return Response.json({ message: 'No referral found for this user' });
      }

      if (referral.status === 'subscribed' || referral.status === 'paid_out') {
        return Response.json({ message: 'Commission already credited' });
      }

      // Update referral record
      await base44.asServiceRole.entities.Referral.update(referral.id, {
        status: 'subscribed',
        commission_amount: commission,
        subscription_tier,
      });

      // Update referrer's balance
      const allUsers2 = await base44.asServiceRole.entities.User.list('-created_date', 5000);
      const users2 = Array.isArray(allUsers2) ? allUsers2 : (allUsers2?.items || []);
      const referrer = users2.find(u => u.email === referral.referrer_email);

      if (referrer) {
        const newBalance = (referrer.referral_balance || 0) + commission;
        const newTotal = (referrer.referral_total_earned || 0) + commission;
        await base44.asServiceRole.entities.User.update(referrer.id, {
          referral_balance: newBalance,
          referral_total_earned: newTotal,
        });
        console.log(`[Referral] Credited $${commission} to ${referrer.email}. New balance: $${newBalance}`);
      }

      return Response.json({ success: true, commission });
    }

    // ACTION: Get referral stats for current user
    if (action === 'get_stats') {
      // Generate code if doesn't exist
      let code = user.referral_code;
      if (!code) {
        const namePart = (user.full_name || 'USER').replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase();
        const randPart = Math.random().toString(36).substring(2, 7).toUpperCase();
        code = `FK-${namePart}-${randPart}`;
        await base44.asServiceRole.entities.User.update(user.id, { referral_code: code });
      }

      const referrals = await base44.asServiceRole.entities.Referral.filter(
        { referrer_email: user.email },
        '-created_date',
        100
      );
      const refList = Array.isArray(referrals) ? referrals : (referrals?.items || []);

      return Response.json({
        referral_code: code,
        referral_link: `${body.origin || 'https://firstknock.app'}/RoleSelect?ref=${code}`,
        balance: user.referral_balance || 0,
        total_earned: user.referral_total_earned || 0,
        referrals: refList.map(r => ({
          id: r.id,
          referred_name: r.referred_name,
          referred_email: r.referred_email,
          status: r.status,
          commission_amount: r.commission_amount,
          created_date: r.created_date,
          paid_out_date: r.paid_out_date,
        })),
        total_referrals: refList.length,
        signed_up: refList.filter(r => r.status === 'signed_up').length,
        subscribed: refList.filter(r => r.status === 'subscribed' || r.status === 'paid_out').length,
      });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('[Referral] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});