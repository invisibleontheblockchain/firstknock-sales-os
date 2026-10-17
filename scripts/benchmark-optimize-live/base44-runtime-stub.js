// Benchmark-only stand-in for Base44 secrets: the engine comes from the shell
// environment (OSRM_BASE_URL, OSRM_GATEWAY_KEY). Nothing is stored in the repo.
export const secrets = { get: (name) => Deno.env.get(name) || '' };
