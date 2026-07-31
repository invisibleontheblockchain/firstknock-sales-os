// Internal FirstKnock record search. The account boundary is enforced by the
// searchAccountRecords backend function, never by filtering in the browser.

import { base44 } from '@/api/base44Client';

export async function searchInternalRecords(query, { limit = 8, signal, invoke } = {}) {
  const call = invoke || ((payload) => base44.functions.invoke('searchAccountRecords', payload));
  const response = await call({ query, limit }, { signal });
  const rows = response?.data?.results;
  return Array.isArray(rows) ? rows : [];
}

export async function createLeadFromAddress(payload, { invoke } = {}) {
  const call = invoke || ((body) => base44.functions.invoke('createLeadFromAddress', body));
  const response = await call(payload);
  return response?.data || {};
}