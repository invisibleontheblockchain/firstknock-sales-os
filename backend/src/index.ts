import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { propertiesRoutes } from './routes/properties.js';
import { routesRoutes } from './routes/routes.js';
import { authPlugin } from './middleware/auth.js';

const fastify = Fastify({
    logger: true,
});

// Enable CORS for frontend and mobile apps
fastify.register(cors, {
    origin: [
        'http://localhost:5173',      // Vite dev server
        'http://localhost:5174',      // Vite alternate port
        'http://10.0.2.2:5173',       // Android emulator -> host
        'capacitor://localhost',      // iOS Capacitor
        'http://localhost',           // Android Capacitor
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    credentials: true,
});

// Health check endpoint
fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
});

// Register route modules
fastify.register(propertiesRoutes);
fastify.register(routesRoutes);
fastify.register(authPlugin);

// Start server
const start = async () => {
    try {
        const port = parseInt(process.env.PORT || '3000');
        await fastify.listen({ port, host: '0.0.0.0' });
        console.log(`🚀 Server running at http://localhost:${port}`);
        console.log(`📊 API endpoints:`);
        console.log(`   GET  /api/properties?zip=XXXXX`);
        console.log(`   GET  /api/properties/:id`);
        console.log(`   GET  /api/zip-codes/:code`);
        console.log(`   GET  /api/routes`);
        console.log(`   POST /api/routes`);
        console.log(`   DELETE /api/routes/:id`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
