/**
 * Initialize Grafana Views
 * 
 * Creates SQL runtime artifacts that are not managed by migrations.
 * View definitions are managed through Prisma migrations.
 * 
 * @module lib/init-grafana-views
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { prisma } from './db';
import { logger } from './logger';

/**
 * Normalizes MySQL-incompatible CREATE INDEX IF NOT EXISTS syntax.
 * MySQL does not support IF NOT EXISTS for CREATE INDEX.
 */
function normalizeMysqlIndexStatement(statement: string): string {
  return statement.replace(
    /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+/i,
    'CREATE INDEX '
  );
}

/**
 * Execute SQL statements from a file
 */
async function executeSqlFile(filePath: string, fileName: string): Promise<void> {
  try {
    const sql = readFileSync(filePath, 'utf-8');
    const sqlWithoutLineComments = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');

    // Split by semicolon and execute each statement
    const statements = sqlWithoutLineComments
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    logger.info({ statementCount: statements.length, fileName }, `Initializing ${fileName}`);

    for (const statement of statements) {
      if (statement.trim()) {
        const normalizedStatement = normalizeMysqlIndexStatement(statement);
        try {
          await prisma.$executeRawUnsafe(normalizedStatement);
        } catch (error: any) {
          // Ignore errors for views/indexes that already exist or tables that don't exist yet
          if (
            error?.code === 'P2010' || // Raw query error
            error?.message?.includes('already exists') ||
            error?.message?.includes("doesn't exist") ||
            error?.message?.includes('Duplicate key name') ||
            error?.message?.includes('Duplicate index')
          ) {
            logger.debug({ error: error.message }, `Skipping ${fileName} statement (may already exist)`);
          } else {
            logger.warn({ error: error.message, statement: statement.substring(0, 100) }, `Failed to execute ${fileName} statement`);
          }
        }
      }
    }

    logger.info({ fileName }, `${fileName} initialized successfully`);
  } catch (error) {
    // If file doesn't exist, that's okay - can be created manually
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ fileName }, `${fileName} not found, skipping initialization`);
    } else {
      logger.error({ error, fileName }, `Failed to initialize ${fileName}`);
    }
  }
}

/**
 * Initialize Grafana SQL runtime artifacts from SQL files
 */
export async function initGrafanaViews(): Promise<void> {
  // Initialize optimization indexes
  await executeSqlFile(join(process.cwd(), 'grafana-views-optimized.sql'), 'grafana-views-optimized.sql');
}

