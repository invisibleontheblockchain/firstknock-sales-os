
import { readFileSync } from 'node:fs';
import { DEFAULT_DECOMPOSITION_PORTFOLIO, sequenceBestDecomposition } from './base44/shared/roadDecompositionPortfolio.js';
import { measureRoadPath } from './base44/shared/roadPathMeasure.js';
const j = JSON.parse(readFileSync('test/fixtures/charlotte-route-1j-ashley-circle.json','utf8'));
const doors = j.stops;
const portfolio = DEFAULT_DECOMPOSITION_PORTFOLIO.filter(c=>c.mandatory);
console.log('portfolio', JSON.stringify(DEFAULT_DECOMPOSITION_PORTFOLIO.map(c=>({id:c.id,mandatory:c.mandatory}))));
const r = await sequenceBestDecomposition(doors, { portfolio, measurePath: measureRoadPath });
console.log(JSON.stringify({ok:r.ok, code:r.code, candidates:r.candidates, telemetry:r.telemetry && Object.keys(r.telemetry)}, null, 1).slice(0,2500));
const m = await measureRoadPath(doors.slice(0,4));
console.log('measure', JSON.stringify(m).slice(0,400));
