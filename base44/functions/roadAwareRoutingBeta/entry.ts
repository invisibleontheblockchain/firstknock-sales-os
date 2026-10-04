import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { secrets } from 'base44:runtime';
import { createRoadAwareBetaHandler } from '../../shared/roadAwareBetaService.js';

Deno.serve(createRoadAwareBetaHandler({ createClient: createClientFromRequest,
    readSecret(name) { try { return String(secrets.get(name) || '').trim(); } catch { return ''; } } }));
