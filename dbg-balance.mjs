
import { partitionRouteTerritories } from './base44/shared/routeTerritoryPartitioner.js';
import { buildSplitAtoms } from './base44/shared/splitAtoms.js';
const D=69, bank=(p)=>Number(p.lng)<0?'w':'e';
const rm=(a,b)=>{const x=(a.lat-b.lat)*D,y=(a.lng-b.lng)*D;return Math.sqrt(x*x+y*y)+(bank(a)===bank(b)?0:6);};
const fetchRows=async(s,d)=>({rows:s.map(p=>d.map(q=>rm(p,q))),requestCount:1});
const optimizeRoute=async(doors)=>{const r=[...doors].sort((a,b)=>a.address_hash<b.address_hash?-1:1);const o=[r.shift()];while(r.length){let bi=0,bm=Infinity;r.forEach((d,i)=>{const m=rm(o[o.length-1],d);if(m<bm-1e-12){bm=m;bi=i;}});o.push(r.splice(bi,1)[0]);}return {order:o};};
const measurePath=async(o)=>{let t=0;for(let i=0;i<o.length-1;i++)t+=rm(o[i],o[i+1]);return {ok:true,totalMiles:t};};
function mk({s=6,d=10}={}){const out=[];['west','east'].forEach(b=>{const base=b==='west'?-0.02:0.02;for(let st=0;st<s;st++)for(let h=0;h<d;h++)out.push({address_hash:`${b}-${st}-${h}`,street_name:`${b==='west'?'Willow':'Elmwood'} ${st} St`,house_number:100+h*2,full_address:`x`,lat:35+st*0.004,lng:base+(b==='west'?-1:1)*h*0.0012});});return out;}
for (const [s,d,k] of [[4,8,3],[12,10,2],[12,10,5],[10,10,5]]) {
  const doors=mk({s,d});
  const atoms=buildSplitAtoms(doors,k,{});
  const r=await partitionRouteTerritories(doors,k,{fetchRows,optimizeRoute,measurePath,allowBalanceRelaxation:true});
  console.log('N',doors.length,'K',k,'atoms',atoms.telemetry.atom_count,'maxAtom',atoms.telemetry.max_atom_doors,'->',r.ok?r.report.selected_candidate:r.code);
  const cands=(r.ok? r.report.candidates : r.candidates)||[];
  cands.slice(0,6).forEach(c=>console.log('   ',c.id,c.ok!==false?'':c.code,JSON.stringify(c.homes_per_route),c.balance&&`[${c.balance.min_homes_allowed}-${c.balance.max_homes_allowed}] below ${c.balance.routes_below_min} above ${c.balance.routes_above_max}`));
}
