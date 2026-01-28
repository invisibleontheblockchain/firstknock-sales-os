import { pgTable, text, integer, real, timestamp, serial, jsonb, varchar } from 'drizzle-orm/pg-core';

// Properties table - matches existing Neon schema
export const properties = pgTable('properties', {
    id: serial('id').primaryKey(),
    address: text('address'),
    full_address: text('full_address'),
    city: text('city'),
    state: text('state'),
    zip_code: varchar('zip_code', { length: 10 }),
    latitude: real('latitude'),
    longitude: real('longitude'),
    beds: integer('beds'),
    baths: real('baths'),
    sqft: integer('sqft'),
    year_built: integer('year_built'),
    price: real('price'),
    sold_date: text('sold_date'),
    address_hash: text('address_hash'),
    smart_score: real('smart_score'),
    created_at: timestamp('created_at').defaultNow(),
});

// Zip codes table
export const zipCodes = pgTable('zip_codes', {
    id: serial('id').primaryKey(),
    code: varchar('code', { length: 10 }).unique(),
    city: text('city'),
    state: text('state'),
    county: text('county'),
    latitude: real('latitude'),
    longitude: real('longitude'),
});

// Saved routes table
export const savedRoutes = pgTable('saved_routes', {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    property_hashes: jsonb('property_hashes').$type<string[]>(),
    metrics: jsonb('metrics').$type<{
        distance?: number;
        house_count?: number;
        score?: number;
    }>(),
    status: text('status').default('PENDING'),
    start_location: jsonb('start_location').$type<{
        lat: number;
        lng: number;
        address?: string;
    }>(),
    created_at: timestamp('created_at').defaultNow(),
    updated_at: timestamp('updated_at').defaultNow(),
});

// Type exports for use in routes
export type Property = typeof properties.$inferSelect;
export type NewProperty = typeof properties.$inferInsert;
export type ZipCode = typeof zipCodes.$inferSelect;
export type SavedRoute = typeof savedRoutes.$inferSelect;
export type NewSavedRoute = typeof savedRoutes.$inferInsert;
