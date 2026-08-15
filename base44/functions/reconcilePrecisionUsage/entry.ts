import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { Client } from 'npm:@neondatabase/serverless@0.9.0';
import Stripe from 'npm:stripe@14.14.0';
import {
    assertImmutablePrecisionJobOwnership,
    calculatePrecisionUsage,
    evaluatePrecisionStartSafety,
    FREE_PRECISION_PROPERTY_LIMIT,
    loadUserPrecisionJobs,
    PrecisionControlError,
    reconcileLegacyPrecisionJobs,
    resolvePrecisionEntitlement,
    withPrecisionUsageLock
} from '../_shared/precisionActiveJobCriteria.js';

const RECONCILIATION_VERSION = 2;

async function loadTargetUser(caller: any, targetEmail: string | null) {
    const normalizedTarget = String(targetEmail || '').trim().toLowerCase();
    if (!normalizedTarget || normalizedTarget === String(caller.email || '').trim().toLowerCase()) return caller;
    throw new PrecisionControlError(
        'precision_reconciliation_forbidden',
        'Cross-account reconciliation is not available through a user-authenticated request.',
        403
    );
}

Deno.serve(async (req: Request) => {
    try {
        const base44 = createClientFromRequest(req);
        const caller = await base44.auth.me();
        if (!caller) return Response.json({ error: 'Unauthorized' }, { status: 401 });
        const body = await req.json().catch(() => ({}));
        const targetEmail = typeof body.target_email === 'string' ? body.target_email : null;
        const user = await loadTargetUser(caller, targetEmail);

        const ledger = await withPrecisionUsageLock({
            userId: user.id,
            ClientClass: Client,
            databaseUrl: Deno.env.get('DATABASE_URL'),
            action: async () => {
                // Resolve Stripe/grant evidence inside the same account lock as
                // reconciliation so a renewal cannot stamp a stale period.
                const entitlement = await resolvePrecisionEntitlement({
                    user,
                    StripeClass: Stripe,
                    stripeSecret: Deno.env.get('STRIPE_SECRET_KEY'),
                    betaAccessGrants: Deno.env.get('BETA_ACCESS_GRANTS')
                });
                // This explicit endpoint retains its historical paid-Stripe
                // policy. Other entitlement kinds remain available through the
                // shared get/start paths without being relabelled as paid here.
                if (
                    entitlement.kind !== 'paid'
                    || entitlement.paidAccess !== true
                    || !entitlement.subscriptionId
                    || !entitlement.periodStart
                    || !entitlement.periodEnd
                ) {
                    throw new PrecisionControlError(
                        'paid_precision_entitlement_required',
                        'An active paid Precision subscription with a current positive payment is required.',
                        409
                    );
                }

                const jobs = await loadUserPrecisionJobs(base44, user);
                assertImmutablePrecisionJobOwnership(jobs, user);
                const initialSafety = evaluatePrecisionStartSafety(jobs);
                const reconciliation = initialSafety.start_blocker_code
                    ? { jobs, reconciledCount: 0, skipped_for_start_blocker: true }
                    : await reconcileLegacyPrecisionJobs({
                        base44,
                        user,
                        jobs,
                        entitlement
                    });
                const reconciledJobs = reconciliation.jobs || jobs;
                const usage = calculatePrecisionUsage(reconciledJobs, entitlement);
                const safety = evaluatePrecisionStartSafety(reconciledJobs);
                const trialProperties = Math.min(
                    FREE_PRECISION_PROPERTY_LIMIT,
                    usage.trialUsed
                );

                if (!initialSafety.start_blocker_code) {
                    await base44.asServiceRole.entities.User.update(user.id, {
                        subscription_period_start: entitlement.periodStart,
                        subscription_period_end: entitlement.periodEnd,
                        precision_usage_period_start: entitlement.periodStart,
                        precision_usage_period_end: entitlement.periodEnd,
                        precision_usage_reconciled_at: new Date().toISOString(),
                        precision_usage_reconciliation_version: RECONCILIATION_VERSION,
                        precision_trial_properties_credited: trialProperties
                    });
                }
                return {
                    entitlement,
                    reconciliation,
                    trialProperties,
                    safety,
                    usage
                };
            }
        });
        const {
            entitlement,
            reconciliation,
            trialProperties,
            safety,
            usage
        } = ledger;

        return Response.json({
            success: true,
            reconciled: reconciliation.reconciledCount > 0,
            reconciled_jobs: reconciliation.reconciledCount,
            precision_usage_period_start: entitlement.periodStart,
            precision_usage_period_end: entitlement.periodEnd,
            trial_properties_credited: trialProperties,
            paid_properties_used: usage.used,
            paid_properties_reserved: usage.reserved,
            paid_properties_remaining: usage.remaining,
            start_available: safety.start_available && usage.remaining > 0,
            start_blocker_code: safety.start_blocker_code,
            start_blocker_job_ids: safety.start_blocker_job_ids,
            unsettled_reservation_count: usage.unsettledReservationCount,
            unsettled_job_ids: usage.unsettledJobIds,
            paid_property_limit: entitlement.limit
        });
    } catch (error: any) {
        console.error('[reconcilePrecisionUsage] Failed:', error?.message || error);
        if (error instanceof PrecisionControlError) {
            return Response.json({
                error: error.code,
                message: error.message
            }, { status: error.status });
        }
        return Response.json({
            error: 'precision_reconciliation_failed',
            message: 'Precision reconciliation could not be completed safely.'
        }, { status: 500 });
    }
});
