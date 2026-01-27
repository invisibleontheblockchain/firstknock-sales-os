import { neon } from '@neondatabase/serverless';

// Neon Postgres connection (serverless-compatible)
const connectionString = 'postgresql://neondb_owner:npg_jsLScDO6w9mf@ep-fragrant-bush-ahixbnax-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require';

const sql = neon(connectionString);

export function getConnection() {
  return sql;
}

// Diagnostic function to verify database connection and data integrity
export async function runDiagnostic() {
  const sql = getConnection();
  const results = {
    connection: { status: 'pending', message: '' },
    tableExists: { status: 'pending', message: '' },
    rowCount: { status: 'pending', count: 0, message: '' },
    schema: { status: 'pending', columns: [], message: '' },
    smartScore: { status: 'pending', stats: {}, message: '' },
    county: { status: 'pending', stats: {}, message: '' },
    stateDistribution: { status: 'pending', states: [], message: '' },
    sampleRecords: { status: 'pending', records: [], message: '' },
  };

  try {
    // 1. Test connection
    const connTest = await sql`SELECT 1 as test`;
    results.connection = { status: 'success', message: 'Connected to Neon Postgres' };

    // 2. Check if properties table exists
    const tableCheck = await sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'properties'
      ) as exists
    `;
    if (tableCheck[0].exists) {
      results.tableExists = { status: 'success', message: 'properties table exists' };
    } else {
      results.tableExists = { status: 'error', message: 'properties table NOT found' };
      return results;
    }

    // 3. Get row count
    const countResult = await sql`SELECT COUNT(*) as count FROM properties`;
    const rowCount = parseInt(countResult[0].count);
    results.rowCount = {
      status: rowCount > 1000000 ? 'success' : 'warning',
      count: rowCount,
      message: `Found ${rowCount.toLocaleString()} records (expected ~1,082,144)`
    };

    // 4. Get schema/columns
    const schemaResult = await sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'properties'
      ORDER BY ordinal_position
    `;
    results.schema = {
      status: 'success',
      columns: schemaResult.map(c => ({ name: c.column_name, type: c.data_type, nullable: c.is_nullable })),
      message: `Found ${schemaResult.length} columns`
    };

    // 5. Check smart_score
    const hasSmartScore = schemaResult.some(c => c.column_name === 'smart_score');
    if (hasSmartScore) {
      const smartScoreStats = await sql`
        SELECT 
          COUNT(*) as total,
          COUNT(smart_score) as with_score,
          MIN(smart_score) as min_score,
          MAX(smart_score) as max_score,
          AVG(smart_score)::numeric(10,2) as avg_score
        FROM properties
      `;
      results.smartScore = {
        status: 'success',
        stats: smartScoreStats[0],
        message: `smart_score: ${smartScoreStats[0].with_score.toLocaleString()} records have scores`
      };
    } else {
      results.smartScore = { status: 'missing', stats: {}, message: 'smart_score column NOT found' };
    }

    // 6. Check county
    const hasCounty = schemaResult.some(c => c.column_name === 'county');
    if (hasCounty) {
      const countyStats = await sql`
        SELECT 
          COUNT(*) as total,
          COUNT(county) as with_county,
          COUNT(DISTINCT county) as unique_counties
        FROM properties
      `;
      results.county = {
        status: 'success',
        stats: countyStats[0],
        message: `county: ${countyStats[0].unique_counties} unique counties`
      };
    } else {
      results.county = { status: 'missing', stats: {}, message: 'county column NOT found' };
    }

    // 7. State distribution
    const stateResult = await sql`
      SELECT state, COUNT(*) as count
      FROM properties
      WHERE state IS NOT NULL
      GROUP BY state
      ORDER BY count DESC
      LIMIT 20
    `;
    results.stateDistribution = {
      status: 'success',
      states: stateResult,
      message: `Top states: ${stateResult.slice(0, 5).map(s => s.state).join(', ')}`
    };

    // 8. Sample records
    const sampleResult = await sql`
      SELECT * FROM properties LIMIT 3
    `;
    results.sampleRecords = {
      status: 'success',
      records: sampleResult,
      message: `Retrieved ${sampleResult.length} sample records`
    };

  } catch (error) {
    results.connection = { status: 'error', message: error.message };
  }

  return results;
}

// Query properties with filters
export async function queryProperties(filters = {}, limit = 100, offset = 0) {
  const sql = getConnection();
  
  let query = sql`SELECT * FROM properties WHERE 1=1`;
  
  // Add filters as needed
  if (filters.state) {
    query = sql`SELECT * FROM properties WHERE state = ${filters.state} LIMIT ${limit} OFFSET ${offset}`;
  } else if (filters.city) {
    query = sql`SELECT * FROM properties WHERE city ILIKE ${filters.city} LIMIT ${limit} OFFSET ${offset}`;
  } else {
    query = sql`SELECT * FROM properties LIMIT ${limit} OFFSET ${offset}`;
  }
  
  return query;
}

// Get property count
export async function getPropertyCount(filters = {}) {
  const sql = getConnection();
  
  if (filters.state) {
    const result = await sql`SELECT COUNT(*) as count FROM properties WHERE state = ${filters.state}`;
    return parseInt(result[0].count);
  }
  
  const result = await sql`SELECT COUNT(*) as count FROM properties`;
  return parseInt(result[0].count);
}