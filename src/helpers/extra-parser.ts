/**
 * Helper functions for parsing the 'extra' field from XProxy API
 * 
 * The 'extra' field is base64 encoded JSON that can contain metadata like version info.
 * 
 * @module helpers/extra-parser
 */

import { logger } from '../lib/logger';

/**
 * Parse base64 encoded extra field and extract app version
 * 
 * @param extra - Base64 encoded string from API (e.g., "e30=" decodes to "{}")
 * @returns Object with parsed JSON and extracted version, or null if parsing fails
 * 
 * @example
 * ```typescript
 * const result = parseExtraField("e30="); // Returns { json: {}, version: null }
 * const result2 = parseExtraField("eyJ2ZXJzaW9uIjogIjEuNDAifQ=="); // Returns { json: { version: "1.40" }, version: "1.40" }
 * ```
 */
export function parseExtraField(extra: string | null | undefined): {
  json: Record<string, any> | null;
  version: string | null;
} {
  if (!extra || extra.trim() === '') {
    return { json: null, version: null };
  }

  try {
    // Decode base64 (Node.js compatible - use Buffer instead of atob)
    const decoded = Buffer.from(extra, 'base64').toString('utf-8');
    
    // Parse JSON
    const json = JSON.parse(decoded);
    
    // Extract version field
    const version = json?.version || null;
    
    return {
      json: typeof json === 'object' && json !== null ? json : null,
      version: typeof version === 'string' ? version : null,
    };
  } catch (error) {
    // Log but don't throw - extra field parsing is optional
    logger.debug(
      {
        extra,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to parse extra field (non-critical)'
    );
    
    return { json: null, version: null };
  }
}

/**
 * Extract app version from extra field
 * Convenience function that only returns the version
 * 
 * @param extra - Base64 encoded string from API
 * @returns Version string or null
 */
export function extractAppVersion(extra: string | null | undefined): string | null {
  return parseExtraField(extra).version;
}
