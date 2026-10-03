import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { mergeAnchoredRoute } from '../src/lib/routeAnchorState.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const executable = source => ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
}).outputText.replace(/^import .*;\s*$/gm, '').replace(/^export\s*\{[^}]*\}\s*from[^;]*;\s*$/gm, '').replace(/^export\s+(?:default\s+)?/gm, '');
const manager = { id: 'manager', email: 'manager@example.com', app_role: 'manager' };
const members = [
    { id: 'self-member', user_id: 'manager', name: 'Manager', email: manager.email },
    { id: 'rep-member', user_id: 'rep', name: 'Rep', email: 'rep@example.com' },
    { id: 'inactive-member', user_id: 'inactive', name: 'Inactive', status: 'inactive' },
];
const route = { id: 'route', manager_id: 'manager', assigned_to: 'manager', status: 'ACTIVE', properties: [], property_hashes: [], name: 'Route' };

function toolbar(initialRoute = route, actor = manager) {
    const states = [];
    let hook = 0;
    let assign = async () => {};
    const source = read('src/components/map/MapToolbar.jsx');
    const ast = ts.createSourceFile('MapToolbar.jsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    const components = {};
    for (const statement of ast.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const clause = statement.importClause;
        if (clause?.name) components[clause.name.text] = clause.name.text;
        for (const binding of clause?.namedBindings?.elements || []) components[binding.name.text] = binding.name.text;
    }
    const useState = initial => {
        const index = hook++;
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
        return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    };
    const context = vm.createContext({
        ...components,
        React: {
            createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
            Fragment: 'Fragment', useMemo: fn => fn(), useRef: value => ({ current: value }),
        },
        useState, useEffect() {}, useCallback: fn => fn,
        useQueryClient: () => ({ invalidateQueries() {} }),
        getRouteOutcomeStats: () => ({ total: 0, byStatus: {}, routeHashes: [], latestByHash: new Map() }),
        FOLLOW_UP_STATUSES: [],
        localStorage: { getItem: () => null },
        OPTIMIZE_MODES: {}, console,
    });
    vm.runInContext(executable(read('src/lib/roles.js')).replace(/^export .*;\s*$/gm, ''), context);
    vm.runInContext(executable(read('src/lib/routeOptimizeUpdate.js')), context);
    vm.runInContext(executable(source), context);
    const props = {
        activeRoute: { ...initialRoute }, user: actor, teamMembers: members, mode: 'analyze', BRAND: {},
        hydratedSavedRoutes: [], repColors: {}, activeRouteSoldFilter: 'all', activeRoutePriceFilter: 'all',
        handleAssignRoute: (...args) => assign(...args),
    };
    function render() {
        hook = 0;
        const elements = [];
        const visit = value => {
            if (Array.isArray(value)) return value.forEach(visit);
            if (!value || typeof value !== 'object') return;
            elements.push(value);
            visit(value.props?.children);
        };
        visit(context.MapToolbar(props));
        return elements;
    }
    const select = () => render().find(element => element.type === 'select' && element.props['aria-label'] === 'Assign route');
    return { props, render, select, setAssign: callback => { assign = callback; } };
}

test('toolbar renders with no active route and no pending assignment', () => {
    const view = toolbar();
    for (const activeRoute of [null, undefined, {}]) {
        view.props.activeRoute = activeRoute;
        assert.doesNotThrow(() => view.render());
    }
    view.props.activeRoute = { ...route };
    assert.equal(view.select().props.value, 'manager');
    view.props.activeRoute = null;
    assert.doesNotThrow(() => view.render());
});

test('rep anchor controls appear only for another assigned team member', () => {
    for (const [assignedTo, expected] of [[null, false], ['manager', false], ['self-member', false], ['rep-member', true], ['rep', true], ['missing-member', false]]) {
        const view = toolbar({ ...route, assigned_to: assignedTo });
        assert.equal(view.render().some(element => element.type === 'RouteAnchorSettings'), expected, String(assignedTo));
    }
    assert.equal(toolbar({ ...route, assigned_to: 'rep-member', status: 'COMPLETED' }).render().some(element => element.type === 'RouteAnchorSettings'), false);
    assert.equal(toolbar({ ...route, assigned_to: 'rep-member' }, { id: 'rep', app_role: 'rep' }).render().some(element => element.type === 'RouteAnchorSettings'), false);
});

test('assignment select resolves both ID formats, keeps Me available, and disables inactive reps', () => {
    for (const assignedTo of ['rep', 'rep-member']) {
        const view = toolbar({ ...route, assigned_to: assignedTo });
        assert.equal(view.select().props.value, 'rep-member');
        const options = view.render().filter(element => element.type === 'option');
        assert.equal(options.find(option => option.props.value === 'manager').props.disabled, undefined);
        assert.equal(options.some(option => option.props.value === 'self-member'), false);
        assert.equal(options.find(option => option.props.value === 'inactive-member').props.disabled, true);
    }
});

test('Me to rep to Me shows the pending selection, blocks duplicate changes, and ends with anchors hidden', async () => {
    const view = toolbar();
    const calls = [];
    let finish;
    view.setAssign((routeId, memberId, useBase) => {
        calls.push([routeId, memberId, useBase]);
        return new Promise(resolve => { finish = () => { view.props.activeRoute = { ...route, assigned_to: memberId }; resolve(); }; });
    });
    for (const memberId of ['rep-member', 'manager']) {
        const previous = view.props.activeRoute.assigned_to;
        const request = view.select().props.onChange({ stopPropagation() {}, target: { value: memberId } });
        assert.equal(view.select().props.value, memberId);
        assert.equal(view.select().props.disabled, true);
        assert.equal(view.props.activeRoute.assigned_to, previous);
        await view.select().props.onChange({ stopPropagation() {}, target: { value: 'inactive-member' } });
        finish();
        await request;
        assert.equal(view.select().props.value, memberId);
        assert.equal(view.select().props.disabled, false);
        assert.equal(view.render().some(element => element.type === 'RouteAnchorSettings'), memberId !== 'manager');
    }
    assert.deepEqual(calls, [['route', 'rep-member', true], ['route', 'manager', true]]);
});

test('a failed assignment restores the saved selection and unlocks the dropdown', async () => {
    const view = toolbar({ ...route, assigned_to: 'rep-member' });
    view.setAssign(async () => { throw new Error('Assignment failed'); });
    await assert.rejects(view.select().props.onChange({ stopPropagation() {}, target: { value: 'manager' } }));
    assert.equal(view.select().props.value, 'rep-member');
    assert.equal(view.select().props.disabled, false);
});

function assignmentHandler() {
    let selected = { ...route };
    let resolve;
    const errors = [];
    const source = ts.createSourceFile('Home.jsx', read('src/pages/Home.jsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    let declaration;
    const visit = node => {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'saveRouteAssignment') declaration = node.getText(source);
        ts.forEachChild(node, visit);
    };
    visit(source);
    assert.ok(declaration);
    const context = vm.createContext({
        base44: { functions: { invoke: () => new Promise(finish => { resolve = finish; }) } },
        queryClient: { invalidateQueries() {} },
        toast: { success() {}, info() {}, error: message => errors.push(message) }, console: { error() {} },
        mergeAnchoredRoute,
        setActiveRoute: updater => { selected = updater(selected); },
    });
    const handler = vm.runInContext(executable('const ' + declaration + ';') + '\nsaveRouteAssignment;', context);
    return { handler, errors, selected: () => selected, select: value => { selected = value; }, finish: saved => resolve({ data: { route: saved } }) };
}

test('late assignment saves cannot reopen a closed route or replace a different selected route', async () => {
    for (const nextRoute of [null, { id: 'other-route', assigned_to: 'manager' }]) {
        const state = assignmentHandler();
        const request = state.handler('route', 'rep-member');
        state.select(nextRoute);
        state.finish({ ...route, assigned_to: 'rep-member' });
        await request;
        assert.equal(state.selected(), nextRoute);
    }
});

test('a successful assignment updates the same selected route with the persisted assignee', async () => {
    const state = assignmentHandler();
    const request = state.handler('route', 'rep-member');
    state.finish({ ...route, assigned_to: 'rep-member', assigned_to_name: 'Rep' });
    const saved = await request;
    assert.equal(saved.assigned_to, 'rep-member');
    assert.equal(state.selected().assigned_to, 'rep-member');
    assert.deepEqual(state.errors, []);
});

function confirmationFlow() {
    const source = ts.createSourceFile('Home.jsx', read('src/pages/Home.jsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    const names = ['handleAssignRoute', 'cancelRouteAssignment', 'confirmRouteAssignment'];
    const declarations = [];
    const visit = node => {
        if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(source))) declarations.push('const ' + node.getText(source) + ';');
        ts.forEachChild(node, visit);
    };
    visit(source);
    let pending = null;
    const writes = [];
    let fail = false;
    const context = vm.createContext({
        activeRoute: route, savedRoutes: [route], teamMembers: members, user: manager,
        assignmentCompletionRef: { current: null },
        setPendingAssignment: value => { pending = value; },
        saveRouteAssignment: async (routeId, memberId, useRepBase) => {
            if (fail) throw new Error('Assignment failed');
            writes.push({ routeId, memberId, useRepBase });
            return { ...route, assigned_to: memberId };
        },
    });
    const handlers = vm.runInContext(executable(declarations.join('\n')) + '\n({handleAssignRoute, cancelRouteAssignment, confirmRouteAssignment});', context);
    return { ...handlers, writes, pending: () => pending, fail: value => { fail = value; } };
}

test('map selection waits for confirmation and cancellation restores it without a write', async () => {
    const state = confirmationFlow();
    const waiting = state.handleAssignRoute('route', 'rep-member', false);
    assert.equal(state.pending().memberName, 'Rep');
    assert.equal(state.writes.length, 0);
    let settled = false;
    waiting.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    state.cancelRouteAssignment();
    assert.equal(await waiting, null);
    assert.equal(state.pending(), null);
    assert.equal(state.writes.length, 0);
});

test('failed confirmation stays pending until a successful retry saves the selected rep', async () => {
    const state = confirmationFlow();
    const waiting = state.handleAssignRoute('route', 'rep-member', false);
    state.fail(true);
    await assert.rejects(state.confirmRouteAssignment(state.pending()), /Assignment failed/);
    assert.equal(state.writes.length, 0);
    assert.equal(await state.handleAssignRoute('route', 'manager'), null);
    state.fail(false);
    await state.confirmRouteAssignment(state.pending());
    assert.equal((await waiting).assigned_to, 'rep-member');
    assert.deepEqual(state.writes, [{ routeId: 'route', memberId: 'rep-member', useRepBase: false }]);
});
