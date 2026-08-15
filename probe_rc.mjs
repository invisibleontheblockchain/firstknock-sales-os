
import { partitionTerritory } from './base44/shared/territoryPartitioner.js';
const doors = Array.from({length:43},(_,index)=>{
  const streetIndex=index%20; const sub=Math.floor(streetIndex/4);
  return { id:'d'+index, address_hash:'d'+index, street_name:'Continuity Street '+streetIndex,
    subdivision_name:'Continuity Neighborhood '+sub,
    lat:35+sub*0.01+(index%7)*0.00001, lng:-82+streetIndex*0.001, house_number:index+1 };
});
const r = partitionTerritory(doors,{ maxHomes:44 });
console.log(JSON.stringify({stats:r.stats, sizes:r.partitions.map(p=>p.doorCount), blocks:r.partitions.map(p=>p.blockCount), model:{blocks:r.model.blockCount,units:r.model.unitCount,doors:r.model.doorCount}}));
