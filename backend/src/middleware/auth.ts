import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createClerkClient } from '@clerk/clerk-sdk-node';

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// Clerk middleware for protected routes
export async function clerkAuth(request: FastifyRequest, reply: FastifyReply) {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Unauthorized: No token provided' });
    }

    const token = authHeader.substring(7);

    try {
        // Verify the session token
        const session = await clerk.sessions.verifySession(token, token);

        // Attach user info to request
        (request as any).userId = session.userId;
        (request as any).sessionId = session.id;
    } catch (error) {
        return reply.status(401).send({ error: 'Unauthorized: Invalid token' });
    }
}

// Optional auth - doesn't fail if no token, just sets userId if present
export async function optionalClerkAuth(request: FastifyRequest, reply: FastifyReply) {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return; // Continue without auth
    }

    const token = authHeader.substring(7);

    try {
        const session = await clerk.sessions.verifySession(token, token);
        (request as any).userId = session.userId;
        (request as any).sessionId = session.id;
    } catch (error) {
        // Ignore errors for optional auth
    }
}

// Register auth plugin
export async function authPlugin(fastify: FastifyInstance) {
    // Decorate request with userId
    fastify.decorateRequest('userId', null);
    fastify.decorateRequest('sessionId', null);

    // GET /api/me - Get current user info
    fastify.get('/api/me', { preHandler: clerkAuth }, async (request, reply) => {
        const userId = (request as any).userId;

        try {
            const user = await clerk.users.getUser(userId);
            return {
                id: user.id,
                email: user.emailAddresses[0]?.emailAddress,
                firstName: user.firstName,
                lastName: user.lastName,
                imageUrl: user.imageUrl,
            };
        } catch (error) {
            return reply.status(500).send({ error: 'Failed to get user' });
        }
    });
}
