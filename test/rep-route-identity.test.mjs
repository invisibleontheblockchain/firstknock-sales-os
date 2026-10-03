import assert from 'node:assert/strict';
import test from 'node:test';
import {ensureRepRouteIdentity, repRouteIdentityNeedsClaim} from '../src/lib/repRouteIdentity.js';
const rep={id:'rep',app_role:'rep',team_manager_id:'manager'};
test('only established reps missing a protected member ID need a claim',()=>{
 assert.equal(repRouteIdentityNeedsClaim(null),false);
 assert.equal(repRouteIdentityNeedsClaim({id:'manager',app_role:'manager'}),false);
 assert.equal(repRouteIdentityNeedsClaim({id:'owner',is_owner:true}),false);
 assert.equal(repRouteIdentityNeedsClaim(rep),true);
 assert.equal(repRouteIdentityNeedsClaim({...rep,data:{team_member_id:'member'}}),false);
});
test('returning rep uses existing trusted onboarding and refreshes authenticated identity',async()=>{
 const calls=[];const verified={...rep,team_member_id:'member'};
 const result=await ensureRepRouteIdentity({
  functions:{invoke:async(name,body)=>{calls.push({name,body});return {data:{team_member_id:'attacker'}};}},
  auth:{me:async()=>verified}
 },rep);
 assert.equal(result,verified);
 assert.deepEqual(calls,[{name:'redeemInviteCode',body:{action:'claim_existing'}}]);
});
test('manager and already-verified rep do not run identity mutations',async()=>{
 for(const user of [{id:'manager',app_role:'manager'},{...rep,team_member_id:'member'}])
  assert.equal(await ensureRepRouteIdentity({},user),user);
});
test('claimed response cannot substitute another user, manager, or role',async()=>{
 for(const verified of [
  {...rep,id:'foreign',team_member_id:'member'},
  {...rep,team_manager_id:'foreign',team_member_id:'member'},
  {...rep,app_role:'manager',team_member_id:'member'},
  {...rep,team_member_id:null},
  {...rep,team_member_id:'member',team_manager_id:null},
 ]) await assert.rejects(ensureRepRouteIdentity({functions:{invoke:async()=>({})},auth:{me:async()=>verified}},rep),/could not be verified/);
});
test('failed claim stops before refreshing identity or loading routes and can be retried',async()=>{
 let shouldFail=true;let reads=0;
 const client={functions:{invoke:async()=>{if(shouldFail)throw new Error('offline');}},auth:{me:async()=>{reads++;return {...rep,team_member_id:'member'};}}};
 await assert.rejects(ensureRepRouteIdentity(client,rep),/offline/);
 assert.equal(reads,0);
 shouldFail=false;
 assert.equal((await ensureRepRouteIdentity(client,rep)).team_member_id,'member');
});

test('rep screen waits for verified identity and retries failed onboarding before route reads', async () => {
 const {readFileSync} = await import('node:fs');
 const {default:ts} = await import('typescript');
 const {default:vm} = await import('node:vm');
 const text=readFileSync(new URL('../src/pages/RepHome.jsx',import.meta.url),'utf8');
 const ast=ts.createSourceFile('RepHome.jsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JSX);
 const descriptors={};
 function visit(node) {
  if(ts.isVariableDeclaration(node)&&node.initializer&&ts.isCallExpression(node.initializer)&&node.initializer.expression.getText(ast)==='useQuery') {
   if(node.name.getText(ast).includes('retryRouteIdentity'))descriptors.identity=node.initializer.getText(ast);
   if(node.name.getText(ast).includes('routesLoading'))descriptors.routes=node.initializer.getText(ast);
  }
  ts.forEachChild(node,visit);
 }
 visit(ast);
 const make=(source,extra={})=>{
  const sandbox={useQuery:config=>config,user:rep,myRoutesQueryKey:['myRoutes','rep'],teamMembersLoading:false,routeIdentityLoading:false,routeIdentityError:false,...extra};
  vm.runInNewContext('globalThis.descriptor = '+source,sandbox);
  return sandbox.descriptor;
 };
 assert.equal(make(descriptors.routes).enabled,true);
 assert.equal(make(descriptors.routes,{routeIdentityLoading:true}).enabled,false);
 assert.equal(make(descriptors.routes,{routeIdentityError:true}).enabled,false);
 const verified={...rep,team_member_id:'member'};const calls=[];
 const descriptor=make(descriptors.identity,{
  repRouteIdentityNeedsClaim,ensureRepRouteIdentity,
  base44:{functions:{invoke:async()=>calls.push('claim')},auth:{me:async()=>verified}},
  queryClient:{setQueryData:(key,value)=>calls.push([Array.from(key),value])},
 });
 assert.equal(descriptor.enabled,true);
 assert.equal(await descriptor.queryFn(),true);
 assert.deepEqual(calls,['claim',[['user'],verified]]);
 assert.equal(make(descriptors.identity,{user:verified,repRouteIdentityNeedsClaim}).enabled,false);
 assert.match(text,/if \(routeIdentityError\) retryRouteIdentity\(\)/);
});
