import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { Client } from 'npm:@neondatabase/serverless@0.9.0';
import Stripe from 'npm:stripe@14.14.0';
import {
    assertImmutablePrecisionJobOwnership,
    calculatePrecisionUsage,
    evaluatePrecisionStartSafety,
    FREE_PRECISION_PROPERTY_LIMIT,
    isMeteredPrecisionEntitlement,
    loadUserPrecisionJobs,
    PrecisionControlError,
    reconcileLegacyPrecisionJobs,
    resolvePrecisionEntitlement,
    withPrecisionUsageLock
} from '../_shared/precisionActiveJobCriteria.js';

const RECONCILIATION_VERSION = 2;

async function reconcileLegacyJobs(base44, user, jobs, entitlement) {
    const reconciliation = await reconcileLegacyPrecisionJobs({
        base44,
        user,
        jobs,
        entitlement
    });
    if (reconciliation.reconciledCount === 0) return reconciliation;

    const usage = calculatePrecisionUsage(jobs, entitlement);
    await base44.asServiceRole.entities.User.update(user.id, {
        precision_usage_reconciled_at: new Date().toISOString(),
        precision_usage_reconciliation_version: RECONCILIATION_VERSION,
        precision_trial_properties_credited: Math.min(FREE_PRECISION_PROPERTY_LIMIT, usage.trialUsed),
        ...(isMeteredPrecisionEntitlement(entitlement) ? {
            subscription_period_start: entitlement.periodStart,
            subscription_period_end: entitlement.periodEnd,
            precision_usage_period_start: entitlement.periodStart,
            precision_usage_period_end: entitlement.periodEnd
        } : {})
    });
    return reconciliation;
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const ledger = await withPrecisionUsageLock({
            userId: user.id,
            ClientClass: Client,
            databaseUrl: Deno.env.get('DATABASE_URL'),
            action: async () => {
                const entitlement = await resolvePrecisionEntitlement({
                    user,
                    StripeClass: Stripe,
                    stripeSecret: Deno.env.get('STRIPE_SECRET_KEY'),
                    betaAccessGrants: Deno.env.get('BETA_ACCESS_GRANTS')
                });
                let jobs = await loadUserPrecisionJobs(base44, user);
                assertImmutablePrecisionJobOwnership(jobs, user);
                const initialSafety = evaluatePrecisionStartSafety(jobs);
                const reconciliation = initialSafety.start_blocker_code
                    ? { jobs, reconciledCount: 0, skipped_for_start_blocker: true }
                    : await reconcileLegacyJobs(base44, user, jobs, entitlement);
                jobs = reconciliation.jobs;
                const safety = evaluatePrecisionStartSafety(jobs);
                return {
                    entitlement,
                    reconciliation,
                    safety,
                    usage: calculatePrecisionUsage(jobs, entitlement)
                };
            }
        });
        const { entitlement, reconciliation, safety, usage } = ledger;

        return Response.json({
            success: true,
            complete: true,
            version: 2,
            as_of: new Date().toISOString(),
            kind: entitlement.kind,
            paid_access: entitlement.paidAccess,
            pro_access: entitlement.proAccess,
            limit: entitlement.limit,
            used: usage.used,
            reserved: usage.reserved,
            meter_used: usage.meterUsed,
            remaining: usage.remaining,
            percent: entitlement.limit > 0
                ? Math.min(100, Math.round((usage.meterUsed / entitlement.limit) * 100))
                : 0,
            period_start: entitlement.periodStart,
            period_end: entitlement.periodEnd,
            subscription_id: entitlement.subscriptionId,
            invoice_id: entitlement.invoiceId,
            lifetime_used: usage.lifetimeUsed,
            trial_used: usage.trialUsed,
            trial_remaining: usage.trialRemaining,
            start_available: safety.start_available && usage.remaining > 0,
            start_blocker_code: safety.start_blocker_code,
            start_blocker_job_ids: safety.start_blocker_job_ids,
            unsettled_reservation_count: usage.unsettledReservationCount,
            unsettled_job_ids: usage.unsettledJobIds,
            reconciliation_applied: reconciliation.reconciledCount > 0,
            reconciled_jobs: reconciliation.reconciledCount
        });
    } catch (error) {
        console.error('[getPrecisionUsage] Failed:', error?.message || error);
        if (
            error instanceof PrecisionControlError
            && [
                'legacy_precision_ownership_unverifiable',
                'legacy_precision_usage_unverifiable'
            ].includes(error.code)
        ) {
            return Response.json({
                success: false,
                complete: false,
                error: error.code,
                message: error.message
            }, { status: error.status });
        }
        return Response.json({
            success: false,
            complete: false,
            error: 'precision_usage_unavailable',
            message: 'Precision usage could not be verified. No property allowance was granted or consumed.'
        }, { status: 503 });
    }
});
