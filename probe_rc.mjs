
import { partitionTerritory } from './base44/shared/territoryPartitioner.js';
const door=(s,h,lat,lng)=>({address_hash:s+'-'+h,house_number:h,street_name:s,city:'Charlotte',state:'NC',zip_code:'28202',lat,lng});
const doors=[
 {...door('Gateway Way',101,35.2000,-80.8500),access:'A'},
 {...door('Gateway Way',103,35.2000,-80.8495),access:'A'},
 {...door('Interior Loop',301,35.2004,-80.8492),access:'A'},
 {...door('Interior Loop',303,35.2004,-80.8488),access:'A'},
 {...door('Separate Court',201,35.2020,-80.8460),access:'B'},
 {...door('Separate Court',203,35.2020,-80.8456),access:'B'},
 {...door('Next Street',401,35.2040,-80.8430),access:'C'},
 {...door('Next Street',403,35.2040,-80.8426),access:'C'}];
const r=partitionTerritory(doors,{routingContext:{accessGroupKey:p=>p.access},maxHomes:4});
console.log(JSON.stringify({n:r.partitions.length,sizes:r.partitions.map(p=>p.doorCount),units:r.units.map(u=>[u.key,u.doorCount]),merge:r.stats.mergeCount}));
