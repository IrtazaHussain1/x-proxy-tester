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
  try {
    logger.info('Checking database schema...');

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
    }
  } catch (error: any) {
    // If schema already exists or other non-critical error, log and continue
    if (
      error?.message?.includes('already exists') ||
      error?.message?.includes('P3009') ||
      error?.message?.includes('P1001') // Connection error
    ) {
      logger.info('Database schema check completed (may already exist)');
      return;
    }

    logger.error(
      {
        error: error?.message || String(error),
      },
      'Failed to initialize database schema'
    );
    // Don't throw - let the app continue and fail gracefully if schema is missing
  }
}

