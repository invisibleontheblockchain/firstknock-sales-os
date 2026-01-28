import { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

const querySchema = z.object({
    zip: z.string().length(5).optional(),
    limit: z.coerce.number().min(1).max(1000).default(500),
});

export async function propertiesRoutes(fastify: FastifyInstance) {
    // GET /api/properties - List properties by zip code
    fastify.get('/api/properties', async (request, reply) => {
        const query = querySchema.parse(request.query);

        if (!query.zip) {
            return reply.status(400).send({ error: 'zip parameter is required' });
        }

        try {
            // Get properties with fallback to zip code centroid for missing lat/lng
            const results = await db.execute(sql`
                SELECT 
                    p.*, 
                    COALESCE(p.latitude, z.latitude) + (random() - 0.5) * 0.015 as latitude,
                    COALESCE(p.longitude, z.longitude) + (random() - 0.5) * 0.015 as longitude
                FROM properties p
                LEFT JOIN zip_codes z ON p.zip_code = z.code
                WHERE p.zip_code = ${query.zip}
                LIMIT ${query.limit}
            `);

            // Get total count
            const countResult = await db.execute(sql`
                SELECT COUNT(*) as count FROM properties WHERE zip_code = ${query.zip}
            `);

            return {
                properties: results.rows,
                total: Number(countResult.rows[0]?.count ?? 0),
                limit: query.limit,
            };
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: 'Database error' });
        }
    });

    // GET /api/properties/:id - Get single property
    fastify.get('/api/properties/:id', async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
            const result = await db.execute(sql`
                SELECT * FROM properties WHERE id = ${parseInt(id)} LIMIT 1
            `);

            if (result.rows.length === 0) {
                return reply.status(404).send({ error: 'Property not found' });
            }

            return result.rows[0];
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: 'Database error' });
        }
    });

    // GET /api/zip-codes/:code - Get zip code metadata
    fastify.get('/api/zip-codes/:code', async (request, reply) => {
        const { code } = request.params as { code: string };

        try {
            const result = await db.execute(sql`
                SELECT * FROM zip_codes WHERE code = ${code} LIMIT 1
            `);

            if (result.rows.length === 0) {
                return reply.status(404).send({ error: 'Zip code not found' });
            }

            return result.rows[0];
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: 'Database error' });
        }
    });
}
