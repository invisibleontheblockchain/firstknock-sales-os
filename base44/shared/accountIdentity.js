export async function loadAuthoritativeUser(base44, authenticatedUser) {
    if (!authenticatedUser?.id) return authenticatedUser;
    const userEntity = base44?.asServiceRole?.entities?.User;
    if (!userEntity?.get) return authenticatedUser;

    const storedUser = await userEntity.get(authenticatedUser.id);
    if (!storedUser || String(storedUser.id) !== String(authenticatedUser.id)) {
        throw new Error('The authenticated account could not be verified.');
    }
    return { ...authenticatedUser, ...storedUser, id: authenticatedUser.id };
}