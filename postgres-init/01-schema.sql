CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS properties (
    id SERIAL PRIMARY KEY,
    sale_type VARCHAR(100),
    sold_date DATE,
    property_type VARCHAR(100),
    address VARCHAR(255),
    city VARCHAR(100),
    state_or_province VARCHAR(50),
    zip_or_postal_code VARCHAR(50),
    price NUMERIC,
    beds INTEGER,
    baths NUMERIC,
    location VARCHAR(255),
    square_feet INTEGER,
    lot_size INTEGER,
    year_built INTEGER,
    days_on_market INTEGER,
    price_per_square_foot NUMERIC,
    hoa_per_month NUMERIC,
    status VARCHAR(50),
    url TEXT,
    source VARCHAR(100),
    mls_number VARCHAR(100),
    latitude NUMERIC,
    longitude NUMERIC,
    geom geometry(Point, 4326)
);

-- Primary spatial index (R-tree via GiST)
CREATE INDEX IF NOT EXISTS properties_geom_idx
  ON properties
  USING GIST (geom);

-- Compound indexes for common filter + spatial queries
CREATE INDEX IF NOT EXISTS properties_geom_price_idx
  ON properties
  USING GIST (geom)
  WHERE price IS NOT NULL;

CREATE INDEX IF NOT EXISTS properties_year_built_idx
  ON properties (year_built)
  WHERE year_built IS NOT NULL;

CREATE INDEX IF NOT EXISTS properties_property_type_idx
  ON properties (property_type)
  WHERE property_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS properties_zip_idx
  ON properties (zip_or_postal_code);

-- ============================================================
-- Martin Function Source: Dynamic filtered MVT tile generation
-- Martin auto-discovers functions matching (z int, x int, y int, query_params json)
-- ============================================================
CREATE OR REPLACE FUNCTION public.properties_mvt(
    z integer,
    x integer,
    y integer,
    query_params json DEFAULT '{}'::json
)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
    mvt bytea;
    envelope geometry;
    p_min_price numeric;
    p_max_price numeric;
    p_min_year  integer;
    p_max_year  integer;
    p_property_type text;
BEGIN
    -- Build tile envelope in Web Mercator (EPSG:3857)
    envelope := ST_TileEnvelope(z, x, y);

    -- Extract optional filter parameters from JSON
    p_min_price     := (query_params ->> 'min_price')::numeric;
    p_max_price     := (query_params ->> 'max_price')::numeric;
    p_min_year      := (query_params ->> 'min_year')::integer;
    p_max_year      := (query_params ->> 'max_year')::integer;
    p_property_type := query_params ->> 'property_type';

    SELECT INTO mvt ST_AsMVT(tile, 'properties_mvt', 4096, 'mvtgeom')
    FROM (
        SELECT
            id,
            address,
            city,
            price,
            beds,
            baths,
            square_feet,
            year_built,
            property_type,
            status,
            ST_AsMVTGeom(
                ST_Transform(geom, 3857),
                envelope,
                4096, 64, true
            ) AS mvtgeom
        FROM public.properties
        WHERE geom IS NOT NULL
          AND ST_Intersects(
                ST_Transform(geom, 3857),
                envelope
              )
          AND (p_min_price IS NULL OR price >= p_min_price)
          AND (p_max_price IS NULL OR price <= p_max_price)
          AND (p_min_year  IS NULL OR year_built >= p_min_year)
          AND (p_max_year  IS NULL OR year_built <= p_max_year)
          AND (p_property_type IS NULL OR property_type = p_property_type)
    ) AS tile;

    RETURN mvt;
END;
$$;
