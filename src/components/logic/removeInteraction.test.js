import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import removeInteraction from './removeInteraction.js';

function fixture() {
    const queryClient = new QueryClient();
    const keys = [['interactionLogs', 'viewer'], ['selectedPropertyHistory', 'house'], ['routeChecklistLogs', 'route']];
    keys.forEach((key) => queryClient.setQueryData(key, [{ id: 'gone' }, { id: 'keep' }]));
    queryClient.setQueryData(['interactionLogs', 'page'], { items: [{ id: 'gone' }, { id: 'keep' }], has_more: true });
    const pendingOutcomes = new Map([
        ['optimistic-a', { id: 'gone', server_id: 'gone' }],
        ['optimistic-b', { id: 'keep' }],
    ]);
    return { queryClient, pendingOutcomes, keys };
}

for (const error of [null, { status: 404 }, { response: { status: 404 } }]) {
    test(`removal reconciles every history cache: ${JSON.stringify(error)}`, async () => {
        const ctx = fixture();
        const result = await removeInteraction({ ...ctx, id: 'gone', remove: async (id) => {
            assert.equal(id, 'gone');
            if (error) throw error;
        } });
        assert.equal(result.missing, Boolean(error));
        ctx.keys.forEach((key) => {
            assert.deepEqual(ctx.queryClient.getQueryData(key), [{ id: 'keep' }]);
            assert.equal(ctx.queryClient.getQueryState(key).isInvalidated, true);
        });
        assert.deepEqual(ctx.queryClient.getQueryData(['interactionLogs', 'page']), { items: [{ id: 'keep' }], has_more: true });
        assert.equal(ctx.pendingOutcomes.has('optimistic-a'), false);
        assert.equal(ctx.pendingOutcomes.has('optimistic-b'), true);
        ctx.queryClient.clear();
    });
}

for (const error of [{ status: 403 }, { status: 500 }, new Error('Network error')]) {
    test(`failed deletion preserves history: ${error.status || error.message}`, async () => {
        const ctx = fixture();
        await assert.rejects(removeInteraction({ ...ctx, id: 'gone', remove: async () => { throw error; } }), (caught) => caught === error);
        ctx.keys.forEach((key) => assert.deepEqual(ctx.queryClient.getQueryData(key), [{ id: 'gone' }, { id: 'keep' }]));
        assert.equal(ctx.pendingOutcomes.size, 2);
        ctx.queryClient.clear();
    });
}

test('an older in-flight history read cannot restore the deleted row', async () => {
    const ctx = fixture();
    let resolveRead;
    const key = ctx.keys[0];
    const reading = ctx.queryClient.fetchQuery({ queryKey: key, queryFn: () => new Promise((resolve) => { resolveRead = resolve; }) }).catch(() => {});
    await removeInteraction({ ...ctx, id: 'gone', remove: async () => {} });
    resolveRead([{ id: 'gone' }]);
    await reading;
    assert.deepEqual(ctx.queryClient.getQueryData(key), [{ id: 'keep' }]);
    ctx.queryClient.clear();
});