
import { partitionTerritory } from './base44/shared/territoryPartitioner.js';
const door=(s,h,lat,lng)=>({address_hash:s+'-'+h,house_number:h,street_name:s,city:'C',state:'NC',zip_code:'28202',lat,lng});
function grid(streets,per){const doors=[];const cols=Math.ceil(Math.sqrt(streets));
 for(let s=0;s<streets;s++){const r=Math.floor(s/cols),c=s%cols;
 for(let h=0;h<per;h++) doors.push(door('Street '+s,100+h*2,35.2+r*0.004,-80.85+c*0.004+h*0.0002));}return doors;}
for(const [label,streets,per] of [['dense',2000,8],['sparse',5334,3]]){
 const doors=grid(streets,per); const t=Date.now(); const r=partitionTerritory(doors);
 console.log(JSON.stringify({label,ms:Date.now()-t,homes:r.stats.doorCount,routes:r.partitions.length,
  homesMin:r.stats.minHomesPerPartition,homesMax:r.stats.maxHomesPerPartition,
  blocksMin:r.stats.minBlocksPerPartition,blocksMax:r.stats.maxBlocksPerPartition,
  overrides:r.overrides.length,exactlyOnce:r.validation.ok,assigned:r.validation.assignedDoorCount,
  tiers:[...new Set(r.partitions.map(p=>p.matrixTier))],roadReady:r.stats.roadReadyPartitions,merge:r.stats.mergeCount}));
}
