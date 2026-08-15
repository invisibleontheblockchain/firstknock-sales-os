
import { createServer } from 'vite';
const vite = await createServer({ server:{middlewareMode:true}, appType:'custom', logLevel:'silent', root:'/app' });
const { generateOptimizedRoutes } = await vite.ssrLoadModule('/src/components/logic/routeOptimizer.jsx');
const ctx = { streetSegmentKey: p=>p.segment, accessGroupKey: p=>p.access,
  distanceBetween:(a,b)=> (Number.isFinite(a.networkPosition)&&Number.isFinite(b.networkPosition)) ? Math.abs(a.networkPosition-b.networkPosition) : Math.abs(a.lng-b.lng) };
const cp=(id,street,hn,lng,np,seg,acc)=>({id,address_hash:id,street_name:street,house_number:hn,city:'Phoenix',zip_code:'85001',lat:33.45,lng,effective_status:'ELIGIBLE',price:350000,networkPosition:np,segment:seg,access:acc});
const doors=[
 cp('ENTRY1','Gateway Way',101,-112.00,0.0,'gateway','NEIGHBORHOOD_A'),
 cp('ENTRY2','Gateway Way',103,-111.95,0.1,'gateway','NEIGHBORHOOD_A'),
 cp('DEAD1','Separate Court',201,-111.00,5.0,'dead_end','DEAD_END_B'),
 cp('DEAD2','Separate Court',203,-110.95,5.1,'dead_end','DEAD_END_B'),
 cp('DEEP1','Interior Loop',301,-110.00,0.2,'interior','NEIGHBORHOOD_A'),
 cp('DEEP2','Interior Loop',303,-109.95,0.3,'interior','NEIGHBORHOOD_A'),
 cp('NEXT1','Next Street',401,-109.00,6.0,'next','NEIGHBORHOOD_C'),
 cp('NEXT2','Next Street',403,-108.95,6.1,'next','NEIGHBORHOOD_C'),
];
const routes = generateOptimizedRoutes(doors, 4, {lat:33.45,lng:-112.1,networkPosition:-0.1}, [], { routeOriginMode:'current_to_home', endLocation:{lat:33.45,lng:-108.9,networkPosition:6.2}, maxRouteDistance:0.00001 }, null, ctx);
console.log('routes:', routes.length);
routes.forEach((r,i)=>console.log(' route'+i+' n='+r.houseCount+' | '+r.properties.map(p=>p.id+'('+p.access+')').join(' -> ')));
// same call without maxRouteDistance
const r2 = generateOptimizedRoutes(doors, 4, {lat:33.45,lng:-112.1,networkPosition:-0.1}, [], { routeOriginMode:'current_to_home', endLocation:{lat:33.45,lng:-108.9,networkPosition:6.2} }, null, ctx);
console.log('no maxRouteDistance -> routes:', r2.length);
r2.forEach((r,i)=>console.log(' route'+i+' n='+r.houseCount+' | '+r.properties.map(p=>p.id+'('+p.access+')').join(' -> ')));
await vite.close();
