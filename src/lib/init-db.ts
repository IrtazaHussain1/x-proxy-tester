/**
 * Database Initialization Module
 * 
 * Initializes the database schema using Prisma.
 * 
 * @module lib/init-db
 */

import { execSync } from 'child_process';
import { logger } from './logger';
import { prisma } from './db';

/**
 * Initialize database schema using Prisma
 * This will create all tables defined in schema.prisma
 */
export async function initDatabaseSchema(): Promise<void> {
  const maxRetries = 5;
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info({ attempt, maxRetries }, 'Checking database schema...');

      // First, check if tables exist
      try {
        await prisma.$queryRaw`SELECT 1 FROM proxies LIMIT 1`;
        logger.info('Database tables already exist');
        
        // Check if migrations need to be applied
        try {
          // Check if source column exists (from latest migration)
          await prisma.$queryRaw`SELECT source FROM proxy_requests LIMIT 1`;
          logger.info('Database schema is up to date');
        } catch (migrationError: any) {
          if (migrationError?.message?.includes('doesn\'t exist') || migrationError?.message?.includes('Unknown column')) {
            logger.info('Database schema needs migration, applying...');
            try {
              execSync('npx --yes prisma migrate deploy', {
                stdio: 'inherit',
                env: {
                  ...process.env,
                  DATABASE_URL: process.env.DATABASE_URL,
                },
                cwd: process.cwd(),
              });
              logger.info('Database migrations applied successfully');
            } catch (migrateError: any) {
              // If migrate deploy fails (e.g., database not empty), try to apply missing columns manually
              logger.warn(
                { error: migrateError?.message },
                'Migration deploy failed, attempting to add missing columns manually'
              );
              try {
                // Check if source column exists first
                const columnExists = await prisma.$queryRawUnsafe(`
                  SELECT COUNT(*) as count
                  FROM INFORMATION_SCHEMA.COLUMNS 
                  WHERE TABLE_SCHEMA = DATABASE()
                    AND TABLE_NAME = 'proxy_requests' 
                    AND COLUMN_NAME = 'source'
                `) as Array<{ count: number }>;
                
                if (columnExists[0]?.count === 0) {
                  // Add source column if it doesn't exist
                  await prisma.$executeRawUnsafe(`
                    ALTER TABLE proxy_requests 
                    ADD COLUMN source VARCHAR(191) NULL DEFAULT 'continuous'
                  `);
                  logger.info('Added missing source column');
                }
                
                // Check if index exists
                const indexExists = await prisma.$queryRawUnsafe(`
                  SELECT COUNT(*) as count
                  FROM INFORMATION_SCHEMA.STATISTICS 
                  WHERE TABLE_SCHEMA = DATABASE()
                    AND TABLE_NAME = 'proxy_requests' 
                    AND INDEX_NAME = 'proxy_requests_source_idx'
                `) as Array<{ count: number }>;
                
                if (indexExists[0]?.count === 0) {
                  await prisma.$executeRawUnsafe(`
                    CREATE INDEX proxy_requests_source_idx ON proxy_requests(source)
                  `);
                  logger.info('Added missing source index');
                }
                
                logger.info('Database schema migration completed');
              } catch (manualError: any) {
                logger.error(
                  { error: manualError?.message },
                  'Failed to add missing columns. Please run fix-database-source-column.sql manually.'
                );
              }
            }
          }
        }
        return;
      } catch (checkError: any) {
        if (checkError?.message?.includes("doesn't exist")) {
          logger.info('Database tables do not exist, creating schema...');
          
          try {
            // Try using npx prisma (works if Prisma is in node_modules or PATH)
            execSync('npx --yes prisma db push --skip-generate --accept-data-loss', {
              stdio: 'inherit',
              env: {
                ...process.env,
                DATABASE_URL: process.env.DATABASE_URL,
              },
              cwd: process.cwd(),
            });
            logger.info('Database schema created successfully');
          } catch (execError: any) {
            // Fallback: try direct node execution
            try {
              const path = require('path');
              const prismaCliPath = path.join(process.cwd(), 'node_modules', '.bin', 'prisma');
              
              execSync(`${prismaCliPath} db push --skip-generate --accept-data-loss`, {
                stdio: 'inherit',
                env: {
                  ...process.env,
                  DATABASE_URL: process.env.DATABASE_URL,
                },
                cwd: process.cwd(),
              });
              logger.info('Database schema created successfully');
            } catch (fallbackError: any) {
              logger.error(
                {
                  error: fallbackError?.message || String(fallbackError),
                  originalError: execError?.message,
                },
                'Failed to create database schema. Please ensure Prisma CLI is available or run: npx prisma db push manually'
              );
              // Don't throw - app can continue, but database operations will fail
            }
          }
        } else {
          // Some other error - might be connection issue
          logger.warn({ error: checkError?.message }, 'Could not check database schema, assuming it exists');
        }
        return; // Success, exit
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
        logger.info('Database schema check completed (may already exist)');
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
    'Failed to initialize database schema after all retries'
  );
  // Don't throw - let the app continue and fail gracefully if schema is missing
}

