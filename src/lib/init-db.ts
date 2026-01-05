/**
 * Database Initialization Module
 * 
 * Syncs the database schema using Prisma (similar to TypeORM's synchronize feature).
 * Automatically syncs schema.prisma to the database on startup.
 * 
 * @module lib/init-db
 */

import { execSync } from 'child_process';
import path from 'path';
import { logger } from './logger';
import { prisma } from './db';

/**
 * Sync database schema using Prisma db push (TypeORM-like sync)
 * This will automatically sync schema.prisma to the database,
 * creating/updating tables and columns as needed.
 */
export async function initDatabaseSchema(): Promise<void> {
  // Define the direct path to the Prisma CLI executable
  const prismaBin = path.join(process.cwd(), 'node_modules', '.bin', 'prisma');
  
  const maxRetries = 5;
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info({ attempt, maxRetries }, 'Syncing database schema...');

      // Test database connection first
      try {
        await prisma.$queryRaw`SELECT 1`;
        logger.info('Database connection successful');
      } catch (connError: any) {
        // If it's a connection error and we have retries left, wait and retry
        if (
          (connError?.code === 'P1001' || connError?.message?.includes('connect')) &&
          attempt < maxRetries
        ) {
          const delay = 2000 * attempt; // Exponential backoff: 2s, 4s, 6s, 8s, 10s
          logger.warn(
            {
              attempt,
              maxRetries,
              delay,
              error: connError?.message,
            },
            'Database connection error, retrying...'
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue; // Retry
        }
        throw connError;
      }

      // Sync schema (like TypeORM's synchronize: true)
      // This will create/update tables and columns to match schema.prisma
      logger.info('Syncing schema to database (db push)...');
      try {
        execSync(`${prismaBin} db push --skip-generate --accept-data-loss`, {
          stdio: 'inherit',
          env: {
            ...process.env,
            DATABASE_URL: process.env.DATABASE_URL,
          },
          cwd: process.cwd(),
        });
        logger.info('Database schema synced successfully');
        return; // Success
      } catch (pushError: any) {
        // db push errors are usually non-critical (e.g., "already in sync")
        if (
          pushError?.message?.includes('already in sync') ||
          pushError?.message?.includes('already exists') ||
          pushError?.message?.includes('P3009')
        ) {
          logger.info('Database schema is already in sync');
          return; // Success
        }
        
        logger.error(
          {
            error: pushError?.message || String(pushError),
          },
          'Failed to sync database schema. Please ensure Prisma CLI is available or run: npx prisma db push manually'
        );
        // Don't throw - app can continue, but database operations may fail
        return;
      }
    } catch (error: any) {
      lastError = error;
      
      // If it's a connection error and we have retries left, wait and retry
      if (
        (error?.code === 'P1001' || error?.message?.includes('connect')) &&
        attempt < maxRetries
      ) {
        const delay = 2000 * attempt; // Exponential backoff: 2s, 4s, 6s, 8s, 10s
        logger.warn(
          {
            attempt,
            maxRetries,
            delay,
            error: error?.message,
          },
          'Database connection error, retrying...'
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue; // Retry
      }
      
      // If schema already exists or other non-critical error, log and continue
      if (
        error?.message?.includes('already exists') ||
        error?.message?.includes('P3009')
      ) {
        logger.info('Database schema sync completed (may already be in sync)');
        return;
      }
    }
  }

  // If we get here, all retries failed
  logger.error(
    {
      error: lastError?.message || String(lastError),
      attempts: maxRetries,
    },
    'Failed to sync database schema after all retries'
  );
  // Don't throw - let the app continue and fail gracefully if schema is missing
}

