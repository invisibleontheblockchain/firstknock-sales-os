import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { buildRepRouteScope, routeIsVisibleInKnock } from '../src/components/rep/repRouteCollection.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function dialogHarness(onConfirm = async () => {}) {
    let cursor = 0;
    const state = [];
    let cancelCount = 0;
    const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
    const useState = initial => {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], value => { state[index] = value; }];
    };
    const source = ts.transpileModule(read('src/components/routes/RouteAssignmentDialog.jsx'), {
        compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText.replace(/^import .*;\s*$/gm, '').replace('export default function', 'function');
    const context = { React: react, useState, Button: 'button', CheckCircle2: 'check', Loader2: 'loading' };
    for (const name of ['Dialog', 'DialogContent', 'DialogDescription', 'DialogFooter', 'DialogHeader', 'DialogTitle']) context[name] = name;
    vm.createContext(context);
    vm.runInContext(source, context);
    return {
        render: () => {
            cursor = 0;
            return context.RouteAssignmentDialog({ assignment: { routeId: 'route', memberId: 'member', routeName: 'Route A', memberName: 'Rep A' },
                onConfirm, onCancel: () => { cancelCount++; } });
        },
        get cancelCount() { return cancelCount; },
    };
}
function elements(node, type) {
    if (!node || typeof node !== 'object') return [];
    return [...(node.type === type ? [node] : []), ...(node.props?.children || []).flat(Infinity).flatMap(child => elements(child, type))];
}

test('canceling the confirmation never saves; confirming saves once and closes on success', async () => {
    const writes = [];
    const harness = dialogHarness(async assignment => { writes.push(assignment); });
    const buttons = elements(harness.render(), 'button');
    assert.equal(writes.length, 0);
    buttons[0].props.onClick();
    assert.equal(writes.length, 0);
    await buttons[1].props.onClick();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].routeId, 'route');
    assert.equal(harness.cancelCount, 2);
});

test('failed saves keep confirmation open with a retryable error and pending saves block dismissal', async () => {
    let reject;
    const harness = dialogHarness(() => new Promise((_, fail) => { reject = fail; }));
    const saving = elements(harness.render(), 'button')[1].props.onClick();
    const pending = harness.render();
    assert.ok(elements(pending, 'button').every(button => button.props.disabled));
    pending.props.onOpenChange(false);
    assert.equal(harness.cancelCount, 0);
    reject(new Error('Assignment failed'));
    await saving;
    const failed = harness.render();
    assert.equal(harness.cancelCount, 0);
    assert.equal(elements(failed, 'p')[0].props.children[0], 'Assignment failed');
    assert.ok(elements(failed, 'button').every(button => !button.props.disabled));
});

test('live updates pick up existing assigned routes and remove reassigned routes without loading peer routes', () => {
    const user = { id: 'rep', email: 'rep@test.local', app_role: 'rep', team_manager_id: 'manager', team_member_id: 'member' };
    const routeScope = buildRepRouteScope(user);
    const source = ts.createSourceFile('RepHome.jsx', read('src/pages/RepHome.jsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    let callbackSource;
    const visit = node => {
        if (ts.isCallExpression(node) && node.expression.getText(source) === 'React.useEffect'
            && node.arguments[0]?.getText(source).includes('base44.entities.SavedRoute.subscribe')) callbackSource = node.arguments[0].getText(source);
        ts.forEachChild(node, visit);
    };
    visit(source);
    assert.ok(callbackSource);
    let onEvent;
    const invalidations = [];
    const context = {
        user, routeScope, routeIsVisibleInKnock, activeRoute: null, manualRouteId: null,
        routes: [{ id: 'old-route', manager_id: 'manager', assigned_to: 'member' }],
        base44: { entities: { SavedRoute: { subscribe: callback => { onEvent = callback; return () => {}; } } } },
        queryClient: { invalidateQueries: ({ queryKey }) => { invalidations.push(Array.from(queryKey)); } },
    };
    vm.runInNewContext('(' + callbackSource + ')()', context);
    onEvent({ id: 'new-assignment', type: 'update', data: { manager_id: 'manager', assigned_to: 'member' } });
    assert.deepEqual(invalidations, [['myRoutes']]);
    invalidations.length = 0;
    onEvent({ id: 'peer-route', type: 'update', data: { manager_id: 'manager', assigned_to: 'peer-member' } });
    assert.deepEqual(invalidations, []);
    onEvent({ id: 'old-route', type: 'update', data: { manager_id: 'manager', assigned_to: 'peer-member' } });
    assert.deepEqual(invalidations, [['myRoutes']]);
});
