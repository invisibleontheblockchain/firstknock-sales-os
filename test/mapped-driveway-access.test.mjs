import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverMappedDrivewayAccess, validateMappedDrivewayAccess } from '../base44/shared/mappedDrivewayAccess.js';
import { createMappedDrivewayFixture } from './fixtures/mapped-driveway-fixture.mjs';

const discover = fixture => discoverMappedDrivewayAccess(fixture.stop, fixture);
const way = (fixture,id) => fixture.mapData.elements.find(e=>e.type==='way'&&e.id===id);
const node = (fixture,id) => fixture.mapData.elements.find(e=>e.type==='node'&&e.id===id);
const restriction = () => ({type:'relation',id:999,version:1,tags:{type:'restriction',restriction:'no_u_turn'},
    members:[{type:'way',ref:16634481,role:'from'},{type:'node',ref:171822265,role:'via'},{type:'way',ref:16634481,role:'to'}]});

test('real Emma geometry automatically finds the public frontage through a private loop driveway', async () => {
    const f=createMappedDrivewayFixture(),access=await discover(f);
    assert.ok(access);
    assert.equal(access.source,'mapped_driveway_recovery');
    assert.deepEqual(access.displayPoint,{lat:f.stop.lat,lng:f.stop.lng});
    assert.deepEqual(access.point,{lat:35.8402171,lng:-80.9930308});
    assert.equal(access.roadName,'Emma Lane');
    assert.equal(validateMappedDrivewayAccess(f.stop,access),true);
    assert.equal(f.mapCalls.length,1);
    assert.equal(f.providerCalls.length,2);
    assert.equal(new URL(f.mapCalls[0]).hostname,'api.openstreetmap.org');
    assert.equal(new URL(f.providerCalls[0]).searchParams.get('radiuses'),'5');
    assert.equal(new URL(f.providerCalls[1]).searchParams.get('radiuses'),'5;5;5');
    assert.equal(JSON.stringify(access).includes('hint'),false);
    assert.ok(access.evidence.snapshot.elements.length<100);
});

for(const [name,change] of [
    ['no independent exact county address',f=>{f.referenceAddress.attributes.add_number='155';}],
    ['county address more than 1000m from the saved pin',f=>{f.referenceAddress.point.lat+=0.03;}],
    ['no explicit matching OSM address',f=>{node(f,4059174054).tags['addr:housenumber']='155';}],
    ['matching address node too far from the county address',f=>{node(f,4059174054).lat+=0.001;}],
    ['driveway too far from the county address',f=>{for(const n of f.mapData.elements.filter(e=>e.type==='node'&&e.id!==4059174054))n.lon-=0.01;}],
    ['geometric crossing without a shared OSM node',f=>{way(f,836726430).nodes[0]=999;f.mapData.elements.push({...node(f,171822265),id:999});}],
    ['missing driveway geometry',f=>{f.mapData.elements=f.mapData.elements.filter(e=>e.id!==7809317404);}],
    ['restricted public road',f=>{way(f,16634481).tags.access='private';}],
    ['motor vehicle restriction',f=>{way(f,16634481).tags.motor_vehicle='no';}],
    ['conditional public road restriction',f=>{way(f,16634481).tags['access:conditional']='no @ (Mo-Fr)';}],
    ['direction-specific motor restriction',f=>{way(f,16634481).tags['motor_vehicle:forward']='no';}],
    ['motorway frontage',f=>{way(f,16634481).tags.highway='motorway';}],
    ['malformed competing-road geometry',f=>{f.mapData.elements.push({type:'way',id:999,version:1,nodes:[171822265,9999],tags:{highway:'residential',name:'Other Road'}});}],
    ['malformed competing highway tag',f=>{f.mapData.elements.push({type:'way',id:999,version:1,nodes:[171822265,7809317390],tags:{highway:['residential'],name:'Other Road'}});}],
    ['oversized competing highway tag',f=>{f.mapData.elements.push({type:'way',id:999,version:1,nodes:[171822265,7809317390],tags:{highway:'residential'.repeat(20),name:'Other Road'}});}],
    ['oversized conditional restriction',f=>{way(f,16634481).tags['access:conditional']='no @ ('+'Mo-Fr '.repeat(40)+')';}],
    ['malformed road restriction',f=>{way(f,16634481).tags.motor_vehicle=['no'];}],
    ['malformed tag collection',f=>{way(f,16634481).tags=null;}],
    ['oneway dead end cannot prove departure',f=>{way(f,16634481).tags.oneway='yes';}],
    ['restricted public junction',f=>{node(f,171822265).tags={barrier:'gate'};}],
    ['different named public frontage',f=>{way(f,16634481).tags.name='Wrong Road';}],
    ['unknown public street name',f=>{delete way(f,16634481).tags.name;}],
    ['incomplete map response',f=>{f.mapData.remark='query truncated';}],
    ['turn restriction at the frontage',f=>{f.mapData.elements.push(restriction());}],
    ['conditional turn restriction at the frontage',f=>{const relation=restriction();relation.tags={type:'restriction','restriction:conditional':'no_u_turn @ (Mo-Fr)'};f.mapData.elements.push(relation);}],
]) test(`rejects ${name} without provider requests`,async()=>{
    const f=createMappedDrivewayFixture();change(f);
    assert.equal(await discover(f),null);
    assert.equal(f.providerCalls.length,0);
});

test('rejects two distinct matching address points',async()=>{
    const f=createMappedDrivewayFixture();f.mapData.elements.push({...structuredClone(node(f,4059174054)),id:999,lat:35.84256});
    assert.equal(await discover(f),null);
});

test('rejects another house associated with the same driveway',async()=>{
    const f=createMappedDrivewayFixture();f.mapData.elements.push({...structuredClone(node(f,4059174054)),id:999,tags:{'addr:housenumber':'156'}});
    assert.equal(await discover(f),null);
});

test('rejects a competing house address on a closed building way',async()=>{
    const f=createMappedDrivewayFixture();
    f.mapData.elements.push({type:'node',id:9991,version:1,lat:35.84251,lon:-80.9909},
        {type:'node',id:9992,version:1,lat:35.84253,lon:-80.9908},
        {type:'node',id:9993,version:1,lat:35.84249,lon:-80.9908},
        {type:'way',id:999,version:1,nodes:[9991,9992,9993,9991],tags:{building:'yes','addr:housenumber':'156'}});
    assert.equal(await discover(f),null);
    assert.equal(f.providerCalls.length,0);
});

test('rejects an address-bearing polygon surrounding the house-side driveway',async()=>{
    const f=createMappedDrivewayFixture();
    f.mapData.elements.push({type:'node',id:9991,version:1,lat:35.8428,lon:-80.9918},
        {type:'node',id:9992,version:1,lat:35.8428,lon:-80.9902},
        {type:'node',id:9993,version:1,lat:35.8418,lon:-80.9902},
        {type:'node',id:9994,version:1,lat:35.8418,lon:-80.9918},
        {type:'way',id:999,version:1,nodes:[9991,9992,9993,9994,9991],tags:{building:'yes','addr:housenumber':'156'}});
    assert.equal(await discover(f),null);
});

test('retains relevant relation evidence and rejects a changed restriction during cache validation',async()=>{
    const f=createMappedDrivewayFixture(),relation=restriction();relation.tags={type:'associatedStreet'};
    f.mapData.elements.push(relation);
    const access=await discover(f);assert.ok(access);
    const saved=access.evidence.snapshot.elements.find(e=>e.type==='relation');
    assert.ok(saved);
    assert.equal(access.evidence.snapshot.inventory.rawRelationCount,1);
    assert.equal(validateMappedDrivewayAccess(f.stop,access),true);
    saved.tags={type:'restriction',restriction:'no_u_turn'};
    assert.equal(validateMappedDrivewayAccess(f.stop,access),false);
});

test('an unrelated turn restriction does not invalidate a legal frontage',async()=>{
    const f=createMappedDrivewayFixture(),relation=restriction();relation.members=[{type:'way',ref:12345,role:'from'},{type:'node',ref:12346,role:'via'},{type:'way',ref:12347,role:'to'}];
    f.mapData.elements.push(relation);
    assert.ok(await discover(f));
});

test('rejects separate driveway components near the same address',async()=>{
    const f=createMappedDrivewayFixture();
    f.mapData.elements.push({type:'node',id:9991,version:1,lat:35.84238,lon:-80.9909},
        {type:'node',id:9992,version:1,lat:35.8424,lon:-80.9908},
        {type:'way',id:999,version:1,nodes:[9991,9992],tags:{highway:'service',service:'driveway'}});
    assert.equal(await discover(f),null);
});

test('rejects a second public junction even when its street name matches',async()=>{
    const f=createMappedDrivewayFixture();way(f,16634481).nodes.push(7809317390);
    assert.equal(await discover(f),null);
});

test('rejects competing named frontage',async()=>{
    const f=createMappedDrivewayFixture();f.mapData.elements.push({type:'way',id:999,version:1,nodes:[171822265,7809317390],tags:{highway:'residential',name:'Other Road'}});
    assert.equal(await discover(f),null);
});

test('checks the full inventory before retaining only the small replayable proof',async()=>{
    const f=createMappedDrivewayFixture();
    for(let i=0;i<1000;i++)f.mapData.elements.push({type:'node',id:900000+i,version:1,lat:35.84,lon:-80.99});
    const access=await discover(f);
    assert.ok(access);
    assert.equal(access.evidence.snapshot.inventory.rawElementCount,f.mapData.elements.length);
    assert.ok(access.evidence.snapshot.elements.length<100);
    assert.ok(JSON.stringify(access).length<10000);
    assert.equal(validateMappedDrivewayAccess(f.stop,access),true);
    f.mapData.elements.push({type:'way',id:999,version:1,nodes:[171822265,7809317390],tags:{highway:'residential',name:'Other Road'}});
    assert.equal(await discover(f),null);
});

for(const [name,change] of [
    ['nearest road mismatch',p=>{p.waypoints[0].name='Other Road';}],
    ['nearest snap outside five meters',p=>{p.waypoints[0].distance=6;}],
    ['provider graph nodes do not identify the mapped road',p=>{p.waypoints[0].nodes=[123,456];}],
    ['competing nearby road snap',p=>{p.waypoints.push({...p.waypoints[0],name:'Other Road'});}],
    ['provider NoSegment',p=>{p.code='NoSegment';}],
])test(`rejects ${name}`,async()=>{
    const f=createMappedDrivewayFixture(),original=f.vehicleFetch;
    f.vehicleFetch=async url=>{const r=await original(url),p=await r.json();if(String(url).includes('/nearest/'))change(p);return{ok:true,json:async()=>p};};
    assert.equal(await discover(f),null);
});

for(const [name,change] of [
    ['unverified departure leg',p=>{p.routes[0].legs.pop();}],
    ['road detour instead of the adjacent legal edge',p=>{p.routes[0].legs[1].distance=1000;}],
    ['route geometry crosses a field',p=>{p.routes[0].geometry.coordinates[1]=[-80.99,35.841];}],
    ['wrong service waypoint',p=>{p.waypoints[1].location=[-80.99,35.841];}],
    ['missing route geometry',p=>{delete p.routes[0].geometry;}],
])test(`rejects ${name}`,async()=>{
    const f=createMappedDrivewayFixture(),original=f.vehicleFetch;
    f.vehicleFetch=async url=>{const r=await original(url),p=await r.json();if(String(url).includes('/route/'))change(p);return{ok:true,json:async()=>p};};
    assert.equal(await discover(f),null);
});

test('cache checks identity, age, topology and both driving directions again',async()=>{
    const f=createMappedDrivewayFixture(),access=await discover(f);
    for(const mutate of [
        a=>{a.evidence.propertyIdentity='another-door';},
        a=>{a.displayPoint.lat+=0.001;},
        a=>{a.resolved_at=new Date(Date.now()-86400001).toISOString();},
        a=>{a.point.lat+=0.001;},
        a=>{a.evidence.referenceAddress.attributes.st_address='154 Wrong Rd';},
        a=>{a.evidence.snapshot.elements.find(e=>e.type==='way'&&e.id==='836726430').nodes[0]='999';},
        a=>{a.evidence.providerProof.roundtrip.legs[1].distance=1000;},
        a=>{a.evidence.snapshot.inventory.queryBounds.xmin+=0.001;},
        a=>{a.evidence.snapshot.inventory.rawElementCount=1;},
        a=>{a.evidence.snapshot.inventory.observedAt=new Date(Date.now()-86400001).toISOString();},
        a=>{a.evidence.unrelated='x'.repeat(128000);},
    ]){const changed=structuredClone(access);mutate(changed);assert.equal(validateMappedDrivewayAccess(f.stop,changed),false);}
});

test('provider failures leave access unresolved',async()=>{
    const f=createMappedDrivewayFixture();f.vehicleFetch=async()=>{throw new Error('unavailable');};
    assert.equal(await discover(f),null);
});

test('rejects oversized evidence and redirect responses',async()=>{
    for(const response of [{ok:true,headers:{get:()=>2_000_001},json:async()=>({})},{ok:true,status:302,redirected:true,json:async()=>({})},
        {ok:true,type:'opaqueredirect',status:0,json:async()=>({})}]){
        const f=createMappedDrivewayFixture();f.fetchImpl=async()=>response;
        assert.equal(await discover(f),null);
    }
});

test('an aborted lookup cannot accept a partial proof',async()=>{
    const f=createMappedDrivewayFixture(),controller=new AbortController();controller.abort();
    await assert.rejects(discoverMappedDrivewayAccess(f.stop,{...f,signal:controller.signal}),{name:'AbortError'});
    assert.equal(f.mapCalls.length,0);
});
