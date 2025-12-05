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

