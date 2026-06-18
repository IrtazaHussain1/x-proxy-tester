/**
 * Database Connection Pool Configuration
 * 
 * Parses and updates DATABASE_URL to include optimal connection pool settings
 * for high-concurrency production environments.
 */

/**
 * Parse positive integer env var with fallback.
 */
function getPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

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
  // Pool defaults can be tuned via env without changing DATABASE_URL.
  // DATABASE_URL query params still take precedence when explicitly provided.
  const defaultConnectionLimit = getPositiveIntEnv('DB_CONNECTION_LIMIT', 60);
  const defaultPoolTimeout = getPositiveIntEnv('DB_POOL_TIMEOUT', 30);
  const defaultConnectTimeout = getPositiveIntEnv('DB_CONNECT_TIMEOUT', 10);

  // Set connection pool parameters if not already set in DATABASE_URL
  if (!params.has('connection_limit')) {
    params.set('connection_limit', String(defaultConnectionLimit));
  }
  if (!params.has('pool_timeout')) {
    params.set('pool_timeout', String(defaultPoolTimeout));
  }
  if (!params.has('connect_timeout')) {
    params.set('connect_timeout', String(defaultConnectTimeout));
  }

  const queryString = params.toString();
  return `${protocol}//${user}:${password}@${host}:${port}/${database}${queryString ? `?${queryString}` : ''}`;
}

/**
 * Get optimized DATABASE_URL with connection pool configuration
 *
 * Defaults:
 * - connection_limit: 60
 * - pool_timeout: 30 seconds
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

/**
 * Build DATABASE_URL with a specific connection_limit, ignoring DB_CONNECTION_LIMIT env var.
 * Used to create purpose-specific Prisma clients (write pool, background pool, etc.)
 */
export function getDatabaseUrlWithConnectionLimit(connectionLimit: number): string {
  const originalUrl = process.env.DATABASE_URL;
  if (!originalUrl) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  const parsed = parseDatabaseUrl(originalUrl);
  // Force-set connection_limit regardless of what was in DATABASE_URL
  parsed.params.set('connection_limit', String(connectionLimit));

  const poolTimeout = getPositiveIntEnv('DB_POOL_TIMEOUT', 30);
  const connectTimeout = getPositiveIntEnv('DB_CONNECT_TIMEOUT', 10);
  if (!parsed.params.has('pool_timeout')) parsed.params.set('pool_timeout', String(poolTimeout));
  if (!parsed.params.has('connect_timeout')) parsed.params.set('connect_timeout', String(connectTimeout));

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
