import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const schema=JSON.parse(readFileSync(new URL('../base44/entities/SavedRoute.jsonc',import.meta.url),'utf8'));
const policy=schema.rls;
const builtInFields=new Set(['id','created_date','updated_date','created_by']);
function allows(rule,route,user) {
  if(typeof rule==='boolean') return rule;
  if(rule.$or) return rule.$or.some(r=>allows(r,route,user));
  if(rule.$and) return rule.$and.every(r=>allows(r,route,user));
  if(rule.user_condition) return Object.entries(rule.user_condition).every(([k,v])=>(user[k]??user.data?.[k])===v);
  return Object.entries(rule).every(([key,expected])=>{
    // Base44 stores custom entity fields under data, not on the record root.
    const actual=key.startsWith('data.') ? route[key.slice(5)] : (builtInFields.has(key) ? route[key] : undefined);
    if(expected?.$nin) return !expected.$nin.includes(actual ?? null);
    if(expected?.$in) return expected.$in.includes(actual ?? null);
    if(typeof expected==='string'&&expected.startsWith('{{')) {
      const key=expected.slice(2,-2).replace(/^user\./,'');
      expected=key.startsWith('data.') ? (user.data?.[key.slice(5)]??user[key.slice(5)]) : user[key];
      if(expected===undefined||expected===null||expected==='') return false;
    }
    return actual===expected;
  });
}
const rep={id:'rep',email:'rep@example.test',app_role:'rep',data:{team_manager_id:'manager',team_member_id:'member'}};
const cases=[
 ['assigned team-member route',rep,{manager_id:'manager',assigned_to:'member'},true],
 ['legacy User-ID assignment',rep,{manager_id:'manager',assigned_to:'rep'},true],
 ['other rep',rep,{manager_id:'manager',assigned_to:'peer'},false],
 ['unassigned',rep,{manager_id:'manager',assigned_to:null},false],
 ['foreign team same member ID',rep,{manager_id:'foreign',assigned_to:'member'},false],
 ['creator after reassignment',rep,{manager_id:'manager',assigned_to:'peer',created_by:rep.email},false],
 ['missing trusted team link',{...rep,data:{}},{manager_id:'manager',assigned_to:'member'},false],
 ['null tenant and null assignee',{...rep,data:{}},{manager_id:null,assigned_to:null},false],
 ['legacy route without tenant',rep,{assigned_to:'member'},false],
 ['manager owns assigned route',{id:'manager',app_role:'manager'},{manager_id:'manager',assigned_to:'member'},true],
 ['manager owns unassigned route',{id:'manager',app_role:'manager'},{manager_id:'manager',assigned_to:null},true],
 ['manager cannot read another team',{id:'manager',app_role:'manager'},{manager_id:'foreign',assigned_to:'peer'},false],
 ['manager legacy creator',{id:'manager',app_role:'manager',email:'manager@example.test'},{created_by:'manager@example.test'},true],
 ['manager creator cannot access foreign tenant',{id:'manager',app_role:'manager',email:'manager@example.test'},{manager_id:'foreign',created_by:'manager@example.test'},false],
 ['rep cannot own an unassigned route',rep,{manager_id:'rep',assigned_to:null},false],
 ['app admin can manage owned routes',{id:'manager',app_role:'admin'},{manager_id:'manager',assigned_to:'member'},true],
 ['platform admin',{id:'admin',role:'admin'},{manager_id:'manager',assigned_to:'peer'},true],
];
for(const [name,user,route,expected] of cases) test(name,()=>{
  for(const op of ['read','update']) assert.equal(allows(policy[op],route,user),expected,op);
});
test('reassignment immediately removes previous rep access',()=>{
 const route={manager_id:'manager',assigned_to:'member'};
 assert.equal(allows(policy.read,route,rep),true);
 route.assigned_to='peer';
 assert.equal(allows(policy.read,route,rep),false);
});
test('rep cannot create or delete routes',()=>{
 assert.equal(allows(policy.create,{},rep),false);
 assert.equal(allows(policy.delete,{manager_id:'manager',assigned_to:'member'},rep),false);
});

test('rep cannot edit the route tenant or assignment fields',()=>{
 for(const field of ['manager_id','assigned_to','assigned_to_name']) {
  const rule=schema.properties[field].rls.write;
  assert.equal(allows(rule,{manager_id:'manager',assigned_to:'member'},rep),false);
  assert.equal(allows(rule,{manager_id:'manager'},{id:'manager',app_role:'manager'}),true);
 }
});
test('team member identity is service-only',()=>{
 const userSchema=JSON.parse(readFileSync(new URL('../base44/entities/User.jsonc',import.meta.url),'utf8'));
 assert.deepEqual(userSchema.properties.team_member_id.rls.write,{user_condition:{role:'admin'}});
});

test('route and roster permission rules use storage paths for custom fields',()=>{
 const roster=JSON.parse(readFileSync(new URL('../base44/entities/TeamMember.jsonc',import.meta.url),'utf8'));
 const check=rule=>{
  if(typeof rule==='boolean') return;
  for(const [key,value] of Object.entries(rule)) {
   if(key==='user_condition') continue;
   if(key.startsWith('$')) value.forEach(check);
   else assert.ok(key.startsWith('data.')||builtInFields.has(key),`Custom field ${key} requires data. prefix`);
  }
 };
 for(const entity of [schema,roster]) {
  Object.values(entity.rls).forEach(check);
  for(const field of Object.values(entity.properties)) Object.values(field.rls||{}).forEach(check);
 }
});

test('a service-created roster profile is readable by its linked rep',()=>{
 const roster=JSON.parse(readFileSync(new URL('../base44/entities/TeamMember.jsonc',import.meta.url),'utf8'));
 const member={id:'member',manager_id:'manager',user_id:'rep',email:rep.email,created_by:'service@example.test'};
 assert.equal(allows(roster.rls.read,member,rep),true);
 assert.equal(allows(roster.rls.read,member,{id:'manager',app_role:'manager'}),true);
 assert.equal(allows(roster.rls.read,member,{id:'foreign',email:'foreign@example.test',data:{team_manager_id:'foreign'}}),false);
});

