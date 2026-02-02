/**
 * Database Connection Pool Configuration
 * 
 * Parses and updates DATABASE_URL to include optimal connection pool settings
 * for high-concurrency production environments.
 */

/**
 * Parse DATABASE_URL and extract connection parameters
 */
function parseDatabaseUrl(url: string): {
  protocol: string;
  user: string;
  password: string;
  host: string;
  port: string;
  database: string;
  params: URLSearchParams;
} {
  try {
    const parsed = new URL(url);
    return {
      protocol: parsed.protocol,
      user: parsed.username,
      password: parsed.password,
      host: parsed.hostname,
      port: parsed.port || '3306',
      database: parsed.pathname.slice(1), // Remove leading '/'
      params: parsed.searchParams,
    };
  } catch (error) {
    throw new Error(`Invalid DATABASE_URL: ${error}`);
  }
}

/**
 * Build DATABASE_URL with connection pool parameters
 */
function buildDatabaseUrl(
  protocol: string,
  user: string,
  password: string,
  host: string,
  port: string,
  database: string,
  params: URLSearchParams
): string {
  // Set optimal connection pool parameters if not already set
  if (!params.has('connection_limit')) {
    params.set('connection_limit', '50'); // Increased from default 10
  }
  if (!params.has('pool_timeout')) {
    params.set('pool_timeout', '20'); // 20 seconds timeout
  }
  if (!params.has('connect_timeout')) {
    params.set('connect_timeout', '10'); // 10 seconds to establish connection
  }

  const queryString = params.toString();
  return `${protocol}//${user}:${password}@${host}:${port}/${database}${queryString ? `?${queryString}` : ''}`;
}

/**
 * Get optimized DATABASE_URL with connection pool configuration
 * 
 * Defaults:
 * - connection_limit: 50 (increased from 10 to handle high concurrency)
 * - pool_timeout: 20 seconds
 * - connect_timeout: 10 seconds
 * 
 * These can be overridden by setting them in the original DATABASE_URL
 */
export function getOptimizedDatabaseUrl(): string {
  const originalUrl = process.env.DATABASE_URL;
  if (!originalUrl) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  const parsed = parseDatabaseUrl(originalUrl);
  return buildDatabaseUrl(
    parsed.protocol,
    parsed.user,
    parsed.password,
    parsed.host,
    parsed.port,
    parsed.database,
    parsed.params
  );
}
