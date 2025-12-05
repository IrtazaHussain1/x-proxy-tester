/**
 * Initialize Grafana Views
 * 
 * Creates SQL views for Grafana dashboards after database schema is ready.
 * 
 * @module lib/init-grafana-views
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { prisma } from './db';
import { logger } from './logger';

/**
 * Initialize Grafana views from SQL file
 */
export async function initGrafanaViews(): Promise<void> {
  try {
    // Read the SQL file
    const sqlPath = join(process.cwd(), 'grafana-views.sql');
    const sql = readFileSync(sqlPath, 'utf-8');

    // Split by semicolon and execute each statement
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'));

    logger.info({ statementCount: statements.length }, 'Initializing Grafana views');

    for (const statement of statements) {
      if (statement.trim()) {
        try {
          await prisma.$executeRawUnsafe(statement);
        } catch (error: any) {
          // Ignore errors for views that already exist or tables that don't exist yet
          if (
            error?.code === 'P2010' || // Raw query error
            error?.message?.includes('already exists') ||
            error?.message?.includes("doesn't exist")
          ) {
            logger.debug({ error: error.message }, 'Skipping view creation (may already exist)');
          } else {
            logger.warn({ error: error.message, statement: statement.substring(0, 100) }, 'Failed to create view');
          }
        }
      }
    }

    logger.info('Grafana views initialized successfully');
  } catch (error) {
    // If file doesn't exist, that's okay - views can be created manually
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug('grafana-views.sql not found, skipping view initialization');
    } else {
      logger.error({ error }, 'Failed to initialize Grafana views');
    }
  }
}

