/**
 * Transaction-scoped Neon advisory lease for one Precision processor job.
 *
 * The transaction remains open on this dedicated Client for the complete
 * processor invocation. That matters for Neon/PgBouncer transaction pooling:
 * BEGIN pins one backend connection, and pg_try_advisory_xact_lock is released
 * automatically by COMMIT, ROLLBACK, or connection loss. The transaction-local
 * idle timeout is disabled before acquisition because a paid provider request
 * can legitimately spend more than Neon's default idle-transaction window
 * without issuing SQL on the lease connection.
 */
export async function claimPrecisionProcessorLease({
    ClientClass,
    databaseUrl,
    jobId
}) {
    if (!databaseUrl || typeof ClientClass !== 'function' || !jobId) {
        throw new Error('Precision processor locking is unavailable.');
    }
    const key = `precision-processor:${String(jobId)}`;
    const client = new ClientClass(databaseUrl);
    await client.connect();
    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL idle_in_transaction_session_timeout = 0');
        const result = await client.query(
            'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS claimed',
            [key]
        );
        const claimed = result?.rows?.[0]?.claimed === true;
        if (!claimed) {
            await client.query('ROLLBACK').catch(() => {});
            await client.end();
            return { claimed: false, key, client: null };
        }
        return { claimed: true, key, client };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        await client.end().catch(() => {});
        throw error;
    }
}

export async function releasePrecisionProcessorLease(lease) {
    if (!lease?.client) return;
    try {
        await lease.client.query('COMMIT');
    } catch (error) {
        await lease.client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        await lease.client.end().catch(() => {});
        lease.client = null;
    }
}

export async function abortPrecisionProcessorLease(lease) {
    if (!lease?.client) return;
    try {
        await lease.client.query('ROLLBACK').catch(() => {});
    } finally {
        await lease.client.end().catch(() => {});
        lease.client = null;
    }
}
