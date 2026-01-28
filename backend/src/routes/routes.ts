import { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

const createRouteSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    property_hashes: z.array(z.string()),
    metrics: z.object({
        distance: z.number().optional(),
        house_count: z.number().optional(),
        score: z.number().optional(),
    }).optional(),
    status: z.string().default('PENDING'),
    start_location: z.object({
        lat: z.number(),
        lng: z.number(),
        address: z.string().optional(),
    }).optional(),
});

export async function routesRoutes(fastify: FastifyInstance) {
    // GET /api/routes - List all saved routes
    fastify.get('/api/routes', async (request, reply) => {
        try {
            const results = await db.execute(sql`
        SELECT * FROM saved_routes ORDER BY created_at DESC LIMIT 100
      `);

            return { routes: results.rows };
        } catch (error: any) {
            // Table might not exist yet
            if (error.message?.includes('does not exist')) {
                return { routes: [], message: 'Routes table not created yet' };
            }
            fastify.log.error(error);
            return reply.status(500).send({ error: 'Database error', details: error.message });
        }
    });

    // GET /api/routes/:id - Get single route
    fastify.get('/api/routes/:id', async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
            const result = await db.execute(sql`
        SELECT * FROM saved_routes WHERE id = ${parseInt(id)} LIMIT 1
      `);

            if (result.rows.length === 0) {
                return reply.status(404).send({ error: 'Route not found' });
            }

            return result.rows[0];
        } catch (error: any) {
            fastify.log.error(error);
            return reply.status(500).send({ error: 'Database error', details: error.message });
        }
    });

    // POST /api/routes - Create new route
    fastify.post('/api/routes', async (request, reply) => {
        try {
            const body = createRouteSchema.parse(request.body);

            const result = await db.execute(sql`
        INSERT INTO saved_routes (name, description, property_hashes, metrics, status, start_location, created_at, updated_at)
        VALUES (
          ${body.name},
          ${body.description || null},
          ${JSON.stringify(body.property_hashes)}::jsonb,
          ${JSON.stringify(body.metrics || {})}::jsonb,
          ${body.status},
          ${JSON.stringify(body.start_location || null)}::jsonb,
          NOW(),
          NOW()
        )
        RETURNING *
      `);

            return reply.status(201).send(result.rows[0]);
        } catch (error: any) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Invalid request body', details: error.errors });
            }
            // If table doesn't exist, create it
            if (error.message?.includes('does not exist')) {
                try {
                    await db.execute(sql`
            CREATE TABLE IF NOT EXISTS saved_routes (
              id SERIAL PRIMARY KEY,
              name TEXT NOT NULL,
              description TEXT,
              property_hashes JSONB,
              metrics JSONB,
              status TEXT DEFAULT 'PENDING',
              start_location JSONB,
              created_at TIMESTAMP DEFAULT NOW(),
              updated_at TIMESTAMP DEFAULT NOW()
            )
          `);
                    // Retry the insert
                    const body = createRouteSchema.parse(request.body);
                    const result = await db.execute(sql`
            INSERT INTO saved_routes (name, description, property_hashes, metrics, status, start_location, created_at, updated_at)
            VALUES (
              ${body.name},
              ${body.description || null},
              ${JSON.stringify(body.property_hashes)}::jsonb,
              ${JSON.stringify(body.metrics || {})}::jsonb,
              ${body.status},
              ${JSON.stringify(body.start_location || null)}::jsonb,
              NOW(),
              NOW()
            )
            RETURNING *
          `);
                    return reply.status(201).send(result.rows[0]);
                } catch (createError) {
                    fastify.log.error(createError);
                    return reply.status(500).send({ error: 'Failed to create routes table' });
                }
            }
            fastify.log.error(error);
            return reply.status(500).send({ error: 'Database error', details: error.message });
        }
    });

    // DELETE /api/routes/:id - Delete route
    fastify.delete('/api/routes/:id', async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
            const result = await db.execute(sql`
        DELETE FROM saved_routes WHERE id = ${parseInt(id)} RETURNING *
      `);

            if (result.rows.length === 0) {
                return reply.status(404).send({ error: 'Route not found' });
            }

            return { success: true, deleted: result.rows[0] };
        } catch (error: any) {
            fastify.log.error(error);
            return reply.status(500).send({ error: 'Database error', details: error.message });
        }
    });
}
