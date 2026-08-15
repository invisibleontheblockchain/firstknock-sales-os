
import { partitionTerritory } from './base44/shared/territoryPartitioner.js';
let id=1; const node=(lat,lng)=>({type:'node',id:id++,lat,lon:lng});
const way=(ns,h='residential')=>({type:'way',id:id++,nodes:ns.map(n=>n.id),tags:{highway:h}});
const door=(s,h,lat,lng)=>({address_hash:s+'-'+h,house_number:h,street_name:s,city:'Charlotte',state:'NC',zip_code:'28202',lat,lng});
function net(){
 const spine=[node(35.2,-80.860),node(35.2,-80.850),node(35.2,-80.848),node(35.2,-80.846),node(35.2,-80.844),node(35.2,-80.834)];
 const ct=[node(35.2010,-80.848),node(35.2016,-80.848)];
 return {elements:[...spine,...ct,way(spine),way([spine[2],ct[0]]),way(ct)]};}
const doors=[door('Main St',100,35.20005,-80.8495),door('Main St',102,35.20005,-80.8485),door('Main St',104,35.20005,-80.8455),door('Main St',106,35.20005,-80.8445),
 door('Quiet Ct',200,35.2010,-80.84795),door('Quiet Ct',202,35.2016,-80.84795)];
const poly=[{lat:35.197,lng:-80.852},{lat:35.197,lng:-80.842},{lat:35.203,lng:-80.842},{lat:35.203,lng:-80.852}];
for (const [label,opts] of [['unbounded',{}],['bounded',{territoryPolygon:poly}]]){
 const r=partitionTerritory(doors,{roadNetwork:net(),...opts});
 console.log(label, r.stats.pocketCount, JSON.stringify(r.units.map(u=>({k:u.key,d:u.doorCount,p:u.protected}))));
}
