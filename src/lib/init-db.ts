/**
 * Database Initialization Module
 * 
 * Syncs the database schema using Prisma (similar to TypeORM's synchronize feature).
 * Automatically syncs schema.prisma to the database on startup.
 * 
 * @module lib/init-db
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { logger } from './logger';
import { prisma, backgroundDb } from './db';

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
        execSync(`${prismaBin} db push --skip-generate`, {
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

/**
 * Builds the ALTER TABLE ... PARTITION BY RANGE COLUMNS SQL for proxy_requests.
 * Generates monthly partitions from Dec 2024 through current month + 6 months,
 * plus a p_future catch-all.
 */
function buildPartitionAlterSQL(): string {
  const partitions: string[] = [];
  const start = new Date(Date.UTC(2024, 11, 1)); // Dec 2024
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 7, 1));

  let current = start;
  while (current < end) {
    const year = current.getUTCFullYear();
    const month = current.getUTCMonth();
    const next = new Date(Date.UTC(year, month + 1, 1));
    const name = `p${year}_${String(month + 1).padStart(2, '0')}`;
    const bound = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01 00:00:00`;
    partitions.push(`    PARTITION ${name} VALUES LESS THAN ('${bound}')`);
    current = next;
  }
  partitions.push('    PARTITION p_future VALUES LESS THAN (MAXVALUE)');

  return [
    'ALTER TABLE proxy_requests',
    '  PARTITION BY RANGE COLUMNS (`timestamp`) (',
    partitions.join(',\n'),
    ')',
  ].join('\n');
}

/**
 * Executes SQL via Prisma CLI (non-prepared protocol path).
 * Use this for MySQL DDL that is not supported by prepared statements
 * (e.g. CREATE EVENT with compound BEGIN...END body).
 */
function executeSqlViaPrismaCli(sql: string): void {
  const prismaBin = path.join(process.cwd(), 'node_modules', '.bin', 'prisma');
  const schemaPath = path.join(process.cwd(), 'prisma', 'schema.prisma');
  if (!existsSync(prismaBin)) {
    throw new Error(
      `Prisma CLI not found at ${prismaBin}. Install prisma as a runtime dependency or run this setup in an environment with Prisma CLI.`
    );
  }

  const result = spawnSync(
    prismaBin,
    ['db', 'execute', '--stdin', '--schema', schemaPath],
    {
      input: sql,
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL,
      },
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );

  if (result.status !== 0) {
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(
      `Prisma db execute failed (status=${String(result.status)}). stdout=${stdout || '<empty>'} stderr=${stderr || '<empty>'}`
    );
  }
}

/**
 * Ensures aggregate summary table has required extended columns.
 * Also adds `id` as PK only when the table has no primary key.
 */
export async function ensureAggregateSummarySchema(): Promise<void> {
  try {
    logger.info('Reconciling aggregate summary schema');
    const hasPrimaryKeyRows = await backgroundDb.$queryRawUnsafe<Array<{ cnt: bigint }>>(
      `SELECT COUNT(*) AS cnt
         FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'proxy_requests_daily_summary'
          AND CONSTRAINT_TYPE = 'PRIMARY KEY'`
    );
    const hasPrimaryKey = Number(hasPrimaryKeyRows[0]?.cnt ?? 0) > 0;

    const hasIdRows = await backgroundDb.$queryRawUnsafe<Array<{ cnt: bigint }>>(
      `SELECT COUNT(*) AS cnt
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'proxy_requests_daily_summary'
          AND COLUMN_NAME = 'id'`
    );
    const hasIdColumn = Number(hasIdRows[0]?.cnt ?? 0) > 0;
    logger.info({ hasPrimaryKey, hasIdColumn }, 'Aggregate summary PK status');

    if (!hasPrimaryKey) {
      if (!hasIdColumn) {
        logger.info('Adding id primary key column to aggregate summary');
        await backgroundDb.$executeRawUnsafe(
          `ALTER TABLE proxy_requests_daily_summary
             ADD COLUMN id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`
        );
      } else {
        logger.info('Adding primary key on existing id column in aggregate summary');
        await backgroundDb.$executeRawUnsafe(
          `ALTER TABLE proxy_requests_daily_summary
             ADD PRIMARY KEY (id)`
        );
      }
    }

    try {
      await backgroundDb.$executeRawUnsafe(
        `ALTER TABLE proxy_requests_daily_summary
           ADD COLUMN device_name VARCHAR(255) NULL AFTER proxy_id`
      );
    } catch (error: any) {
      const msg = error?.message || '';
      if (!msg.includes('Duplicate column name')) throw error;
    }
    logger.info('Ensured device_name column exists on aggregate summary');

    try {
      await backgroundDb.$executeRawUnsafe(
        `ALTER TABLE proxy_requests_daily_summary
           ADD COLUMN server_name VARCHAR(32) NULL AFTER device_name`
      );
    } catch (error: any) {
      const msg = error?.message || '';
      if (!msg.includes('Duplicate column name')) throw error;
    }
    logger.info('Ensured server_name column exists on aggregate summary');

    try {
      await backgroundDb.$executeRawUnsafe(
        `CREATE INDEX idx_proxy_requests_daily_summary_server_name
           ON proxy_requests_daily_summary (server_name)`
      );
    } catch (error: any) {
      const msg = error?.message || '';
      if (!msg.includes('Duplicate key name')) throw error;
    }
    logger.info('Ensured server_name index exists on aggregate summary');

    logger.info('Aggregate summary schema reconciliation completed');
  } catch (error: any) {
    logger.error({ error: error?.message || String(error) }, 'Failed to reconcile aggregate summary schema');
  }
}

/**
 * Ensures proxy_requests is partitioned by month and the monthly management
 * EVENT exists. Safe to call on every startup — all steps are idempotent.
 *
 * On a fresh database (no partitions, no event) this will:
 *   1. Drop the FK constraint (incompatible with partitioned tables)
 *   2. Expand the PK to (id, timestamp) — required by MySQL for partition key
 *   3. Apply RANGE COLUMNS partitioning covering Dec 2024 → now+6 months
 *   4. Drop legacy batch-DELETE events (superseded by partition DROP)
 *   5. Create the manage_proxy_requests_partitions monthly event
 */
export async function ensurePartitioningSetup(): Promise<void> {
  try {
    // ── Check if already partitioned ──────────────────────────────────────────
    const partRows = await backgroundDb.$queryRawUnsafe<Array<{ cnt: bigint }>>(
      `SELECT COUNT(*) AS cnt
         FROM information_schema.PARTITIONS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'proxy_requests'
          AND PARTITION_NAME IS NOT NULL`
    );
    const isPartitioned = Number(partRows[0]?.cnt ?? 0) > 0;

    if (!isPartitioned) {
      logger.info('proxy_requests is not partitioned — running partition setup...');

      // Step 1: Drop FK if it exists (partitioned tables cannot have FKs)
      const fkRows = await backgroundDb.$queryRawUnsafe<Array<{ cnt: bigint }>>(
        `SELECT COUNT(*) AS cnt
           FROM information_schema.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA    = DATABASE()
            AND TABLE_NAME      = 'proxy_requests'
            AND CONSTRAINT_NAME = 'proxy_requests_proxy_id_fkey'
            AND CONSTRAINT_TYPE = 'FOREIGN KEY'`
      );
      if (Number(fkRows[0]?.cnt ?? 0) > 0) {
        await backgroundDb.$executeRawUnsafe(
          'ALTER TABLE proxy_requests DROP FOREIGN KEY proxy_requests_proxy_id_fkey'
        );
        logger.info('Dropped FK proxy_requests_proxy_id_fkey');
      }

      // Step 2: Expand PK to (id, timestamp) if not already
      const pkRows = await backgroundDb.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
        `SELECT COLUMN_NAME
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA    = DATABASE()
            AND TABLE_NAME      = 'proxy_requests'
            AND CONSTRAINT_NAME = 'PRIMARY'`
      );
      const pkCols = pkRows.map(r => r.COLUMN_NAME);
      if (!pkCols.includes('timestamp')) {
        await backgroundDb.$executeRawUnsafe(
          'ALTER TABLE proxy_requests DROP PRIMARY KEY, ADD PRIMARY KEY (id, `timestamp`)'
        );
        logger.info('Expanded proxy_requests PK to (id, timestamp)');
      }

      // Step 3: Apply RANGE COLUMNS partitioning
      await backgroundDb.$executeRawUnsafe(buildPartitionAlterSQL());
      logger.info('Applied RANGE COLUMNS partitioning to proxy_requests');
    } else {
      logger.info({ partitionCount: Number(partRows[0]?.cnt) }, 'proxy_requests is already partitioned');
    }

    // ── Step 4: Drop superseded batch-DELETE events ────────────────────────────
    // DROP EVENT is not supported in prepared statement protocol on some MySQL setups.
    executeSqlViaPrismaCli('DROP EVENT IF EXISTS cleanup_old_proxy_requests;');
    executeSqlViaPrismaCli('DROP EVENT IF EXISTS cleanup_old_speed_tests;');

    // ── Step 5: Ensure monthly partition management event exists ───────────────
    const eventRows = await backgroundDb.$queryRawUnsafe<Array<{
      STATUS: string;
      LAST_EXECUTED: Date | null;
    }>>(
      `SELECT STATUS, LAST_EXECUTED
         FROM information_schema.EVENTS
        WHERE EVENT_SCHEMA = DATABASE()
          AND EVENT_NAME   = 'manage_proxy_requests_partitions'`
    );

    if (eventRows.length === 0 || eventRows[0].STATUS !== 'ENABLED') {
      if (eventRows.length > 0) {
        logger.warn({ status: eventRows[0].STATUS }, 'manage_proxy_requests_partitions is not ENABLED — recreating');
        executeSqlViaPrismaCli('DROP EVENT IF EXISTS manage_proxy_requests_partitions;');
      }

      executeSqlViaPrismaCli(`
        CREATE EVENT manage_proxy_requests_partitions
          ON SCHEDULE EVERY 1 MONTH
          STARTS (DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01 02:00:00'))
          ON COMPLETION PRESERVE
          DO BEGIN
            SET @drop_month_start = DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 2 MONTH), '%Y-%m-01');
            SET @drop_month_end   = DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 MONTH), '%Y-%m-01');

            SET @old_part = CONCAT('p', DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 2 MONTH), '%Y_%m'));
            SET @drop_sql = CONCAT('ALTER TABLE proxy_requests DROP PARTITION IF EXISTS ', @old_part);
            PREPARE stmt FROM @drop_sql;
            EXECUTE stmt;
            DEALLOCATE PREPARE stmt;

            SET @new_part_name  = CONCAT('p', DATE_FORMAT(DATE_ADD(NOW(), INTERVAL 2 MONTH), '%Y_%m'));
            SET @new_part_bound = DATE_FORMAT(
              DATE_ADD(LAST_DAY(DATE_ADD(NOW(), INTERVAL 2 MONTH)), INTERVAL 1 DAY),
              '%Y-%m-%d 00:00:00'
            );
            SET @reorg_sql = CONCAT(
              'ALTER TABLE proxy_requests REORGANIZE PARTITION p_future INTO (',
                'PARTITION ', @new_part_name, ' VALUES LESS THAN (''', @new_part_bound, '''),',
                'PARTITION p_future VALUES LESS THAN (MAXVALUE)',
              ')'
            );
            PREPARE stmt FROM @reorg_sql;
            EXECUTE stmt;
            DEALLOCATE PREPARE stmt;
          END
      `);
      logger.info('Created manage_proxy_requests_partitions MySQL event');
    } else {
      const lastRun = eventRows[0].LAST_EXECUTED;
      const daysSinceRun = lastRun
        ? (Date.now() - lastRun.getTime()) / (1000 * 60 * 60 * 24)
        : Infinity;
      if (daysSinceRun > 35) {
        logger.warn({ lastRun, daysSinceRun: daysSinceRun.toFixed(1) },
          'manage_proxy_requests_partitions has not run in 35+ days. Verify event_scheduler=ON in MySQL.');
      } else {
        logger.info({ lastRun }, 'Partition management EVENT is healthy');
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to set up partitioning (non-fatal — app will continue but proxy_requests may be unpartitioned)');
  }
}

