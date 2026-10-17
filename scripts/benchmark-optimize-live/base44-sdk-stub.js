// Benchmark-only stand-in for the Base44 SDK: an authenticated user, no entities.
export const createClientFromRequest = () => ({
    auth: { me: async () => ({ id: 'benchmark-user', email: 'benchmark@example.com' }) },
});
