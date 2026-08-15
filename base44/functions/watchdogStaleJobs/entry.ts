import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
    hasPrecisionJobMarkers,
    isActualPrecisionJob,
    isPrecisionReservationUnsettled,
    listAllPrecisionRecords,
    precisionProcessorTokenHash,
    precisionReservationAmount
} from '../_shared/precisionActiveJobCriteria.js';

// Sweeps stalled Precision jobs and hands exact usage settlement back to the
// processor. A watchdog must never release a reservation itself: the worker
// may have persisted properties immediately before stalling.
const STALE_THRESHOLD_MS = 30 * 60 * 1000;
const PROCESSOR_RECOVERY_WAIT_MS = 900;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function timestampMs(value) {
    const parsed = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
}

function inspectReservation(job) {
    try {
        return {
            amount: precisionReservationAmount(job),
            unsettled: isPrecisionReservationUnsettled(job),
            error: null
        };
    } catch (error) {
        return {
            amount: null,
            unsettled: true,
            error
        };
    }
}

function staleReferenceMs(job) {
    return job?.status === 'pending'
        ? timestampMs(job.created_date)
        : timestampMs(
            job.processor_heartbeat_at
            || job.updated_date
            || job.started_at
            || job.created_date
        );
}

function needsRecovery(job, now, reservation = inspectReservation(job)) {
    if (job?.precision_watchdog_recovery_at) {
        return reservation.unsettled || job?.status !== 'failed';
    }
    if (['completed', 'cancelled', 'failed'].includes(job?.status)) return reservation.unsettled;
    if (!['pending', 'running'].includes(job?.status)) return false;
    return now - staleReferenceMs(job) > STALE_THRESHOLD_MS;
}

function isAuthorizedWatchdogRequest(req) {
    const expected = Deno.env.get('PRECISION_WATCHDOG_SECRET');
    const received = req.headers.get('x-precision-watchdog-secret');
    return Boolean(expected) && received === expected;
}

async function invokeProcessorRecovery(base44, job, processorToken) {
    const invocation = base44.asServiceRole.functions.invoke('processFetchChunk', {
        job_id: job.id,
        expected_chunk: job.chunk_number || 0,
        processor_token: processorToken
    }).catch(error => {
        console.warn(`[watchdog] Processor recovery handoff failed for ${job.id}: ${error.message}`);
        return null;
    });
    await Promise.race([invocation, sleep(PROCESSOR_RECOVERY_WAIT_MS)]);
}

Deno.serve(async (req) => {
    try {
        if (!isAuthorizedWatchdogRequest(req)) {
            return Response.json({ error: 'Forbidden: watchdog authorization required' }, { status: 403 });
        }
        const base44 = createClientFromRequest(req);

        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const fetchJobs = base44.asServiceRole.entities.FetchJob;
        // Active recovery must never depend on scanning terminal history.
        // Terminal candidates are queried by incomplete-ledger evidence below,
        // instead of loading every completed/failed/cancelled FetchJob.
        const activeFilters = ['running', 'pending'].flatMap(status => ([
            { status, precision_usage_reserved: { $gt: 0 } },
            { status, precision_usage_count: { $gt: 0 } },
            { status, precision_usage_user_id: { $ne: null } },
            { status, precision_usage_kind: { $ne: null } },
            { status, precision_usage_period_start: { $ne: null } },
            { status, precision_usage_period_end: { $ne: null } },
            { status, precision_usage_recorded_at: { $ne: null } },
            { status, precision_subscription_id: { $ne: null } },
            { status, precision_invoice_id: { $ne: null } },
            { status, precision_cancel_requested_at: { $ne: null } },
            { status, precision_watchdog_recovery_at: { $ne: null } },
            { status, processor_claim_id: { $ne: null } },
            { status, source_fetch_job_id: { $ne: null } },
            { status, root_fetch_job_id: { $ne: null } },
            { status, attempt_reason: { $ne: null } }
        ]));
        const activeResults = await Promise.allSettled(activeFilters.map(filter =>
            listAllPrecisionRecords(
                fetchJobs,
                filter,
                '-created_date'
            )
        ));
        const activeGroups = activeResults
            .filter(result => result.status === 'fulfilled')
            .map(result => result.value);
        const activeFailures = activeResults.filter(result => result.status === 'rejected');
        const activeScanError = activeFailures[0]?.reason || null;
        if (activeFailures.length) {
            console.error(
                `[watchdog] ${activeFailures.length} active settlement candidate scan(s) failed:`,
                activeScanError.message
            );
            return Response.json({
                status: 'partial',
                error: 'precision_job_discovery_incomplete',
                message: 'Active Precision discovery was incomplete. No recovery state was changed.',
                recovery_requested: 0,
                stale_jobs_fixed: 0,
                active_scan_complete: false
            }, { status: 503 });
        }
        const activeIdentityConflicts = activeGroups
            .flat()
            .filter(job => hasPrecisionJobMarkers(job) && !isActualPrecisionJob(job))
            .map(job => job.id);
        if (activeIdentityConflicts.length) {
            return Response.json({
                status: 'conflict',
                error: 'precision_job_identity_conflict',
                message: 'Active marker-bearing rows have conflicting Precision identity. No recovery state was changed.',
                conflicting_job_ids: [...new Set(activeIdentityConflicts)],
                recovery_requested: 0,
                stale_jobs_fixed: 0,
                active_scan_complete: false
            }, { status: 409 });
        }
        const terminalStatuses = ['cancelled', 'failed', 'completed'];
        const terminalFilters = terminalStatuses.flatMap(status => ([
            // Query only strong Precision identity/evidence classes. Generic
            // zero/null ledger permutations match schema defaults on unrelated
            // FetchJobs and can make recovery discovery unbounded.
            { status, precision_usage_reserved: { $gt: 0 } },
            { status, precision_usage_count: { $gt: 0 } },
            { status, precision_usage_user_id: { $ne: null } },
            { status, precision_usage_kind: { $ne: null } },
            { status, precision_usage_period_start: { $ne: null } },
            { status, precision_usage_period_end: { $ne: null } },
            { status, precision_usage_recorded_at: { $ne: null } },
            { status, precision_subscription_id: { $ne: null } },
            { status, precision_invoice_id: { $ne: null } },
            { status, precision_cancel_requested_at: { $ne: null } },
            { status, precision_watchdog_recovery_at: { $ne: null } },
            { status, processor_claim_id: { $ne: null } },
            { status, source_fetch_job_id: { $ne: null } },
            { status, root_fetch_job_id: { $ne: null } },
            { status, attempt_reason: { $ne: null } }
        ]));
        let terminalGroups = [];
        let terminalScanError = null;
        const terminalResults = await Promise.allSettled(terminalFilters.map(filter =>
            listAllPrecisionRecords(fetchJobs, filter, '-created_date')
        ));
        terminalGroups = terminalResults
            .filter(result => result.status === 'fulfilled')
            .map(result => result.value);
        const terminalFailures = terminalResults.filter(result => result.status === 'rejected');
        if (terminalFailures.length) {
            // Recovery is all-or-nothing: a candidate scan that cannot prove
            // completeness must not mutate any job or enqueue a processor.
            terminalScanError = terminalFailures[0].reason;
            console.error(
                `[watchdog] ${terminalFailures.length} terminal settlement candidate scan(s) failed:`,
                terminalScanError.message
            );
            return Response.json({
                status: 'partial',
                error: 'precision_job_discovery_incomplete',
                message: 'Terminal Precision discovery was incomplete. No recovery state was changed.',
                recovery_requested: 0,
                stale_jobs_fixed: 0,
                active_scan_complete: true,
                terminal_scan_complete: false
            }, { status: 503 });
        }
        const jobsById = new Map();
        const markerIdentityConflicts = [];
        for (const group of [...activeGroups, ...terminalGroups]) {
            for (const job of group) {
                if (hasPrecisionJobMarkers(job) && !isActualPrecisionJob(job)) {
                    markerIdentityConflicts.push(job.id);
                } else if (isActualPrecisionJob(job)) {
                    jobsById.set(job.id, job);
                }
            }
        }
        if (markerIdentityConflicts.length) {
            return Response.json({
                status: 'conflict',
                error: 'precision_job_identity_conflict',
                message: 'Marker-bearing rows have conflicting Precision identity. No recovery state was changed.',
                conflicting_job_ids: [...new Set(markerIdentityConflicts)],
                recovery_requested: 0,
                stale_jobs_fixed: 0
            }, { status: 409 });
        }
        const blockedJobIds = new Set();
        const activeByImmutableSubject = new Map();
        const unverifiableActiveJobIds = [];
        for (const job of jobsById.values()) {
            if (!['pending', 'running'].includes(job.status)) continue;
            const immutableSubjectId = typeof job.precision_usage_user_id === 'string'
                ? job.precision_usage_user_id.trim()
                : '';
            if (!immutableSubjectId) {
                blockedJobIds.add(job.id);
                unverifiableActiveJobIds.push(job.id);
                continue;
            }
            const group = activeByImmutableSubject.get(immutableSubjectId) || [];
            group.push(job);
            activeByImmutableSubject.set(immutableSubjectId, group);
        }
        const activeConflicts = [];
        for (const [immutableSubjectId, group] of activeByImmutableSubject) {
            if (group.length <= 1) continue;
            const activeJobIds = group.map(job => job.id);
            activeJobIds.forEach(jobId => blockedJobIds.add(jobId));
            activeConflicts.push({
                code: 'multiple_active_precision_jobs',
                precision_usage_user_id: immutableSubjectId,
                active_job_ids: activeJobIds
            });
        }

        let recovered = 0;
        let pending = 0;
        let requested = 0;

        for (const candidate of jobsById.values()) {
            // Gate 7: an automatic recovery sweep never selects among
            // ambiguous active jobs or email-only ownership evidence.
            if (blockedJobIds.has(candidate.id)) continue;
            let reservation = inspectReservation(candidate);
            if (!needsRecovery(candidate, now, reservation)) continue;

            let job = await base44.asServiceRole.entities.FetchJob.get(candidate.id).catch(() => candidate);
            reservation = inspectReservation(job);
            if (reservation.error) {
                console.error(`[watchdog] Malformed reservation evidence on ${job.id}: ${reservation.error.message}`);
            }
            const watchdogInitiated = Boolean(job.precision_watchdog_recovery_at)
                || ['pending', 'running', 'failed'].includes(job.status);

            // A prior handoff may have settled asynchronously after candidate
            // discovery. Only validated complete ledger evidence can suppress
            // recovery; a truthy malformed/partial timestamp cannot.
            if (!reservation.unsettled) {
                if (
                    (job.precision_watchdog_recovery_at || ['pending', 'running'].includes(job.status))
                    && job.status !== 'failed'
                ) {
                    const updateMany = fetchJobs.updateMany;
                    const filter: any = { id: job.id, status: job.status };
                    if (Object.prototype.hasOwnProperty.call(job, 'processor_claim_id')) {
                        filter.processor_claim_id = job.processor_claim_id;
                    }
                    const finalized = typeof updateMany === 'function'
                        ? await updateMany.call(fetchJobs, filter, {
                            $set: {
                                status: 'failed',
                                processor_claim_id: null,
                                completed_at: job.completed_at || nowIso,
                                error_message: 'Job stalled and was stopped safely. Please try pulling data again.',
                                error_log: [
                                    ...(job.error_log || []),
                                    `[${nowIso}] Watchdog finalized the job after exact Precision usage settlement.`
                                ]
                            }
                        })
                        : null;
                    if (finalized?.success === true && Number(finalized?.updated) === 1) recovered++;
                }
                continue;
            }

            const processorToken = crypto.randomUUID();
            const processorTokenHash = await precisionProcessorTokenHash(processorToken);
            const recoveryUpdate: any = {};
            if (watchdogInitiated && !job.precision_watchdog_recovery_at) {
                recoveryUpdate.precision_watchdog_recovery_at = nowIso;
                recoveryUpdate.error_log = [
                    ...(job.error_log || []),
                    `[${nowIso}] Watchdog requested processor-owned recovery; the ${reservation.amount ?? 'unverifiable'}-property reservation remains held until exact settlement.`
                ];
            }
            recoveryUpdate.processor_claim_id = job.processor_claim_id ?? null;
            recoveryUpdate.dry_run_metadata = {
                ...(job.dry_run_metadata || {}),
                processor_token: null,
                processor_token_hash: processorTokenHash
            };
            const updateMany = fetchJobs.updateMany;
            const recoveryFilter: any = { id: job.id, status: job.status };
            if (Object.prototype.hasOwnProperty.call(job, 'processor_claim_id')) {
                recoveryFilter.processor_claim_id = job.processor_claim_id;
            }
            const recoveryClaim = typeof updateMany === 'function'
                ? await updateMany.call(
                    fetchJobs,
                    recoveryFilter,
                    { $set: recoveryUpdate }
                )
                : null;
            if (
                recoveryClaim?.success !== true
                || Number(recoveryClaim?.updated) !== 1
                || recoveryClaim?.has_more === true
            ) {
                pending++;
                continue;
            }
            requested++;
            job = await base44.asServiceRole.entities.FetchJob.get(job.id).catch(() => ({ ...job, ...recoveryUpdate }));

            await invokeProcessorRecovery(base44, job, processorToken);
            const latest = await base44.asServiceRole.entities.FetchJob.get(job.id).catch(() => null);
            const latestReservation = latest ? inspectReservation(latest) : {
                amount: null,
                unsettled: true,
                error: new Error('Processor recovery result could not be reloaded.')
            };
            if (latest && !latestReservation.unsettled) {
                let terminalStateVerified = true;
                if ((watchdogInitiated || latest.precision_watchdog_recovery_at) && latest.status !== 'failed') {
                    const terminalFilter: any = {
                        id: latest.id,
                        status: latest.status,
                        precision_usage_reserved: latest.precision_usage_reserved,
                        precision_usage_count: latest.precision_usage_count,
                        precision_usage_recorded_at: latest.precision_usage_recorded_at
                    };
                    for (const field of [
                        'processor_claim_id',
                        'precision_watchdog_recovery_at',
                        'precision_cancel_requested_at'
                    ]) {
                        if (Object.prototype.hasOwnProperty.call(latest, field)) {
                            terminalFilter[field] = latest[field];
                        }
                    }
                    const finalized = typeof fetchJobs.updateMany === 'function'
                        ? await fetchJobs.updateMany.call(
                            fetchJobs,
                            terminalFilter,
                            {
                                $set: {
                                    status: 'failed',
                                    processor_claim_id: null,
                                    completed_at: latest.completed_at || nowIso,
                                    error_message: 'Job stalled and was stopped safely. Please try pulling data again.',
                                    error_log: [
                                        ...(latest.error_log || []),
                                        `[${nowIso}] Watchdog finalized the job after exact Precision usage settlement.`
                                    ]
                                }
                            }
                        )
                        : null;
                    terminalStateVerified = (
                        finalized?.success === true
                        && Number(finalized?.updated) === 1
                        && finalized?.has_more !== true
                    );
                }
                if (terminalStateVerified) recovered++;
                else pending++;
            } else {
                // Keep the reservation in force. The persisted recovery marker
                // makes the next sweep retry without another 30-minute delay.
                pending++;
            }
        }

        console.log(`[watchdog] Sweep complete: recovered=${recovered}, pending_settlement=${pending}, recovery_requested=${requested}, checked=${jobsById.size}`);
        const discoveryError = activeScanError || terminalScanError;
        const conflictPresent = activeConflicts.length > 0 || unverifiableActiveJobIds.length > 0;
        return Response.json({
            ...(activeConflicts.length ? { error: 'multiple_active_precision_jobs' } : {}),
            status: discoveryError ? 'partial' : conflictPresent ? 'conflict' : 'ok',
            stale_jobs_fixed: recovered,
            recovery_requested: requested,
            settlement_pending: pending,
            jobs_checked: jobsById.size,
            active_scan_complete: activeScanError === null,
            active_scan_error: activeScanError?.code || activeScanError?.message || null,
            terminal_scan_complete: terminalScanError === null,
            terminal_scan_error: terminalScanError?.code || terminalScanError?.message || null,
            active_conflicts: activeConflicts,
            unverifiable_active_job_ids: unverifiableActiveJobIds
        }, { status: discoveryError ? 503 : conflictPresent ? 409 : 200 });
    } catch (error) {
        console.error('[watchdog] Error:', error);
        return Response.json({
            error: 'precision_watchdog_unavailable',
            message: 'Precision recovery could not complete safely.'
        }, { status: 500 });
    }
});
