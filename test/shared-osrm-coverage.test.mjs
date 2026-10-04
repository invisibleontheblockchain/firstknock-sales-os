import test from 'node:test';
import assert from 'node:assert/strict';
import {insideRoadBetaCoverage,assertRoadBetaProxyRequest} from '../base44/shared/roadAwareBetaPolicy.js';
import {fetchRoadBetaProxy} from '../base44/shared/roadAwareBetaService.js';
test('national cohort supports Salisbury and distant US cities with unchanged 100 m matching',()=>{
  for(const [lat,lng] of [[35.6709,-80.4742],[35.2271,-80.8431],[33.4484,-112.074],[61.2181,-149.9003],[21.3069,-157.8583]]) assert.ok(insideRoadBetaCoverage({lat,lng}));
  assert.doesNotThrow(()=>assertRoadBetaProxyRequest('nearest','-80.4742,35.6709',{radiuses:'100',number:'1'}));
  assert.throws(()=>assertRoadBetaProxyRequest('nearest','-80.4742,35.6709',{radiuses:'150',number:'1'}),/100 m/);
});
test('gateway graph fingerprint and version must both match before measurements reach optimizer',async()=>{
  const fingerprint='a'.repeat(64),dataVersion='us-fixture';
  const options={provider:{baseUrl:'https://routing.example'},service:'nearest',coordinates:'-80.4742,35.6709',query:{radiuses:'100',number:'1'},fingerprint,dataVersion,token:'server-token'};
  for(const data of [{code:'Ok',data_version:dataVersion},{code:'Ok',data_version:'wrong',build_fingerprint:fingerprint},{code:'Ok',data_version:dataVersion,build_fingerprint:'b'.repeat(64)}])
    await assert.rejects(fetchRoadBetaProxy({...options,fetchImpl:async()=>Response.json(data)}),/identity changed/);
  let auth;const response=await fetchRoadBetaProxy({...options,fetchImpl:async(_,init)=>{auth=init.headers.Authorization;return Response.json({code:'Ok',data_version:dataVersion,build_fingerprint:fingerprint});}});
  assert.equal(response.status,200);assert.equal(auth,'Bearer server-token');
});
