
import { partitionTerritory } from './base44/shared/territoryPartitioner.js';
let id=1; const node=(lat,lng)=>({type:'node',id:id++,lat,lon:lng});
const way=(ns,h='residential')=>({type:'way',id:id++,nodes:ns.map(n=>n.id),tags:{highway:h}});
const door=(s,h,lat,lng)=>({address_hash:s+'-'+h,house_number:h,street_name:s,city:'Charlotte',state:'NC',zip_code:'28202',lat,lng});
function net(){const spine=[node(35.2,-80.85),node(35.2,-80.848),node(35.2,-80.846),node(35.2,-80.844)];
const loop=[node(35.202,-80.85),node(35.202,-80.844)];const stub=[node(35.198,-80.846),node(35.197,-80.846)];
return {elements:[...spine,...loop,...stub,way(spine),way(loop),way([spine[0],loop[0]]),way([spine[3],loop[1]]),way([spine[2],stub[0]]),way(stub)]};}
const doors=[door('Grid St',100,35.20005,-80.8496),door('Grid St',102,35.20005,-80.8488),door('Grid St',104,35.20005,-80.847),
door('Quiet Ct',200,35.1979,-80.84605),door('Quiet Ct',202,35.1976,-80.84598),door('Quiet Ct',204,35.1973,-80.84602)];
for (const low of [null,35.1975,35.1985,35.199]){
  const poly = low===null?undefined:[{lat:low,lng:-80.852},{lat:low,lng:-80.842},{lat:35.203,lng:-80.842},{lat:35.203,lng:-80.852}];
  const r=partitionTerritory(doors,{roadNetwork:net(),territoryPolygon:poly});
  console.log(low, r.stats.pocketCount, r.units.map(u=>u.key+':'+u.doorCount).join('|'));
}
