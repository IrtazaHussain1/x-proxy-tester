/**
 * Performance Optimizations Initialization
 * 
 * Runs database migrations for performance indexes and summary tables,
 * and populates initial summary data.
 * 
 * @module lib/init-performance-optimizations
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { prisma } from './db';
import { logger } from './logger';
import { populateRecentSummaries } from '../services/hourly-summary';

/**
 * Runs a single migration file
 */
async function runMigration(migrationPath: string, migrationName: string): Promise<void> {
  if (!existsSync(migrationPath)) {
    logger.debug({ migrationName }, 'Migration file not found, skipping');
    return;
  }

  try {
    const migrationSql = readFileSync(migrationPath, 'utf-8');
      
      // Split by semicolon and execute each statement
      const statements = migrationSql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith('--') && !s.startsWith('DELIMITER'));

    logger.info({ statementCount: statements.length, migrationName }, 'Running migration');

    // Handle procedures separately (they need DELIMITER handling)
    const procMatches = [
      migrationSql.match(/CREATE\s+PROCEDURE\s+populate_hourly_summary[\s\S]*?END\s*\/\//),
      migrationSql.match(/CREATE\s+PROCEDURE\s+aggregate_daily_summary[\s\S]*?END\s*\/\//),
    ].filter(Boolean);

    for (const procMatch of procMatches) {
      if (procMatch) {
        try {
          const procSql = procMatch[0].replace(/\/\//g, ';').replace(/DELIMITER\s+\/\/\s*/g, '').replace(/DELIMITER\s+;\s*/g, '');
          await prisma.$executeRawUnsafe(procSql);
          logger.debug('Stored procedure created');
        } catch (error: any) {
          if (error?.message?.includes('already exists')) {
            logger.debug('Stored procedure already exists, skipping');
          } else {
            logger.warn({ error: error.message }, 'Failed to create stored procedure');
          }
        }
      }
    }

    // Execute other statements
    for (const statement of statements) {
      if (statement.trim() && !statement.includes('CREATE PROCEDURE') && !statement.includes('DELIMITER')) {
        try {
          await prisma.$executeRawUnsafe(statement);
        } catch (error: any) {
          // Ignore errors for objects that already exist
          if (
            error?.message?.includes('already exists') ||
            error?.message?.includes('Duplicate key name') ||
            error?.message?.includes('Duplicate column name') ||
            error?.code === 'P2010' ||
            error?.code === '42S21' // Duplicate column
          ) {
            logger.debug({ error: error.message }, 'Object already exists, skipping');
          } else {
            logger.warn({ error: error.message, statement: statement.substring(0, 100) }, 'Migration statement failed');
          }
        }
      }
    }

    logger.info({ migrationName }, 'Migration completed');
  } catch (error: any) {
    logger.warn({ error: error.message, migrationName }, 'Failed to run migration');
  }
}

/**
 * Runs performance optimization migrations
 */
export async function initPerformanceOptimizations(): Promise<void> {
  try {
    logger.info('Initializing performance optimizations...');

    // Run hourly summary migration
    const hourlyMigrationPath = join(
      process.cwd(),
      'prisma',
      'migrations',
      '20250112000000_add_performance_indexes_and_summary_table',
      'migration.sql'
    );
    await runMigration(hourlyMigrationPath, 'hourly_summary');

    // Run daily summary migration
    const dailyMigrationPath = join(
      process.cwd(),
      'prisma',
      'migrations',
      '20250112000001_add_daily_summary_table',
      'migration.sql'
    );
    await runMigration(dailyMigrationPath, 'daily_summary');

    logger.info('Performance optimization migrations completed');

    // Populate initial hourly summaries for the last 24 hours (in background)
    // This helps Grafana queries work immediately
    logger.info('Populating initial hourly summaries (last 24 hours)...');
    void populateRecentSummaries(24).then((count) => {
      logger.info({ populated: count }, 'Initial hourly summaries populated');
    }).catch((error) => {
      logger.error({ error: error.message }, 'Failed to populate initial summaries');
    });

  } catch (error) {
    logger.error({ error }, 'Failed to initialize performance optimizations');
    // Don't throw - let app continue even if optimizations fail
  }
}

