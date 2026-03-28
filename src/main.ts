/**
 * Main Application Entry Point
 * Starts continuous proxy testing with runtime management.
 */

import 'dotenv/config';
import { startContinuousTesting, stopContinuousTesting } from './services/continuous-proxy-tester';
import { startSpeedTestService, stopSpeedTestService } from './services/speed-test-service';
import { stopIpRotationTesting } from './services/ip-rotation-testing';
import { stopHourlySummaryService } from './services/hourly-summary';
import { stopDailyAggregationService } from './services/daily-aggregation';
import { batchWriter } from './lib/batch-writer';
import { logger } from './lib/logger';
import { config } from './config';
import { startServer } from './server';
import { initGrafanaViews } from './lib/init-grafana-views';
import { initDatabaseSchema } from './lib/init-db';
import { initPerformanceOptimizations } from './lib/init-performance-optimizations';
import { waitForDatabase } from './lib/db';
import { stopPeriodicIpRotation, cleanupWorkers, startPeriodicIpRotation } from './services/ip-rotation';
import { startDuplicateIpSnapshotService, stopDuplicateIpSnapshotService } from './services/duplicate-ip-snapshot';

/**
 * Main application entry point
 * 
 * Starts continuous proxy testing with runtime management:
 * - If RUN_MODE="fixed": Runs for at least MIN_RUN_HOURS, then stops
 * - If RUN_MODE="infinite": Runs indefinitely until manually stopped (SIGINT/SIGTERM)
 * 
 * In infinite mode, shutdown is allowed immediately.
 * In fixed mode, shutdown is blocked until minimum hours have passed.
 */
async function main(): Promise<void> {
  const startTime = Date.now();
  const minRunMs = config.runtime.minRunHours * 60 * 60 * 1000;
  let shutdownRequested = false;

  // Check if the application has run for the minimum required hours
  function hasMetMinimumRuntime(): boolean {
    const elapsedMs = Date.now() - startTime;
    return elapsedMs >= minRunMs;
  }

  // Calculate how many milliseconds remain until minimum runtime is met
  function getRemainingTimeMs(): number {
    const elapsedMs = Date.now() - startTime;
    return Math.max(0, minRunMs - elapsedMs);
  }

  // Handle shutdown signals (SIGINT/SIGTERM) with runtime protection
  // In fixed mode, blocks shutdown until minimum runtime is met
  function handleShutdownRequest(signal: string): void {
    if (shutdownRequested) {
      logger.warn('Shutdown already in progress, ignoring signal');
      return;
    }

    shutdownRequested = true;

    if (config.runtime.runMode === 'infinite') {
      // Infinite mode: allow immediate shutdown
      logger.info(`Received ${signal}, shutting down gracefully...`);
      stopPeriodicIpRotation();
      cleanupWorkers();
      stopContinuousTesting();
      stopSpeedTestService();
      stopHourlySummaryService();
      stopDailyAggregationService();
      stopDuplicateIpSnapshotService();
      // Flush any pending batch writes before shutdown
      void batchWriter.forceFlush().then(() => {
        void stopIpRotationTesting().then(() => {
          process.exit(0);
        });
      });
    } else {
      // Fixed mode: check if minimum runtime met
      if (hasMetMinimumRuntime()) {
        logger.info(
          {
            signal,
            runTimeHours: ((Date.now() - startTime) / (60 * 60 * 1000)).toFixed(2),
            minRunHours: config.runtime.minRunHours,
          },
          `Received ${signal}, minimum runtime met, shutting down gracefully...`
        );
        stopPeriodicIpRotation();
        cleanupWorkers();
        stopContinuousTesting();
        stopSpeedTestService();
        stopHourlySummaryService();
        stopDailyAggregationService();
        stopDuplicateIpSnapshotService();
        // Flush any pending batch writes before shutdown
        void batchWriter.forceFlush().then(() => {
          void stopIpRotationTesting().then(() => {
            process.exit(0);
          });
        });
      } else {
        const remainingHours = (getRemainingTimeMs() / (60 * 60 * 1000)).toFixed(2);
        logger.warn(
          {
            signal,
            remainingHours,
            minRunHours: config.runtime.minRunHours,
            runMode: config.runtime.runMode,
          },
          `Shutdown requested but minimum runtime not met. Need ${remainingHours} more hours. Ignoring shutdown request.`
        );
        shutdownRequested = false; // Allow future shutdown attempts
      }
    }
  }

  try {
    logger.info(
      {
        minRunHours: config.runtime.minRunHours,
        runMode: config.runtime.runMode,
        monitorCheckIntervalMs: config.runtime.monitorCheckIntervalMs,
      },
      'XProxy Tester Application Starting'
    );

    // Start HTTP server for health checks and metrics endpoints
    startServer();

    // Wait for database to be ready (important for Docker startup)
    // MySQL container may take time to initialize, so we retry with exponential backoff
    logger.info('Waiting for database connection...');
    const dbReady = await waitForDatabase(30); // 30 attempts with exponential backoff (up to ~2 minutes)
    if (!dbReady) {
      logger.error('Database is not ready after waiting. Application will continue but database operations may fail.');
      // Don't exit - let the app start and retry connections on demand
    } else {
      logger.info('Database connection established successfully');
    }

    // Initialize database schema (create tables if they don't exist)
    await initDatabaseSchema();

    // Initialize performance optimizations (indexes, summary tables)
    await initPerformanceOptimizations();

    // Initialize Grafana views (after database schema is ready)
    await initGrafanaViews();

    // Start continuous testing
    await startContinuousTesting();

    // Start speed test service
    startSpeedTestService();

    // Start periodic IP rotation service (standard service with DB logging)
    // This handles the "Periodic: Run every n minutes for all proxies" requirement
    if (config.ipRotation.enabled) {
      startPeriodicIpRotation(config.ipRotation.periodicRotationIntervalMs);
      logger.info(
        {
          intervalMs: config.ipRotation.periodicRotationIntervalMs,
          intervalMinutes: (config.ipRotation.periodicRotationIntervalMs / 60000).toFixed(1),
        },
        'Periodic IP rotation service started'
      );
    } else {
      logger.info('Periodic IP rotation service is disabled');
    }

    logger.info(
      {
        duplicateIpSnapshotEnabled: config.duplicateIpSnapshot.enabled,
        duplicateIpSnapshotIntervalMs: config.duplicateIpSnapshot.intervalMs,
        duplicateIpSnapshotRetentionDays: config.duplicateIpSnapshot.retentionDays,
      },
      'Duplicate IP snapshot configuration'
    );
    if (config.duplicateIpSnapshot.enabled) {
      startDuplicateIpSnapshotService(
        config.duplicateIpSnapshot.intervalMs,
        config.duplicateIpSnapshot.retentionDays
      );
    } else {
      logger.info('Duplicate IP snapshot service is disabled (DUPLICATE_IP_SNAPSHOT_ENABLED=false)');
    }

    // Start IP rotation testing service (runs alongside continuous testing)
    // NOTE: Disabled by default to avoid conflict with standard periodic rotation
    // if (config.ipRotationTesting.enabled) {
    //   startIpRotationTesting();
    //   logger.info(
    //     {
    //       rotationIntervalMs: config.ipRotationTesting.rotationIntervalMs,
    //       rotationIntervalMinutes: (config.ipRotationTesting.rotationIntervalMs / 60000).toFixed(1),
    //       testConcurrency: config.ipRotationTesting.testConcurrency,
    //     },
    //     'IP rotation testing service started'
    //   );
    // } else {
    //   logger.info('IP rotation testing service is disabled');
    // }

    // TEMP: disable aggregation/archival to avoid errors when summary tables are missing
    // startHourlySummaryService();
    // logger.info('Hourly summary service started');

    // startDailyAggregationService();
    // logger.info('Daily aggregation service started');

    // const archivalEnabled = process.env.ENABLE_ARCHIVAL !== 'false';
    // const archivalIntervalMs = parseInt(process.env.ARCHIVAL_INTERVAL_MS || String(12 * 60 * 60 * 1000), 10);
    // const retentionDays = parseInt(process.env.DATA_RETENTION_DAYS || '14', 10);
    // if (archivalEnabled) {
    //   startPeriodicArchival(archivalIntervalMs, retentionDays);
    //   logger.info(
    //     {
    //       retentionDays,
    //       intervalHours: archivalIntervalMs / (60 * 60 * 1000),
    //     },
    //     'Periodic data archival enabled'
    //   );
    // }

    // Set up signal handlers
    process.on('SIGINT', () => handleShutdownRequest('SIGINT'));
    process.on('SIGTERM', () => handleShutdownRequest('SIGTERM'));

    // If fixed mode, set up runtime monitor to auto-shutdown after minimum hours
    if (config.runtime.runMode === 'fixed') {
      logger.info(
        {
          minRunHours: config.runtime.minRunHours,
          minRunMs,
        },
        `Fixed mode: Will run for at least ${config.runtime.minRunHours} hours, then auto-shutdown`
      );

      // Monitor runtime and auto-shutdown when minimum is met
      const monitorInterval = setInterval(() => {
        if (hasMetMinimumRuntime()) {
          clearInterval(monitorInterval);
          logger.info(
            {
              runTimeHours: ((Date.now() - startTime) / (60 * 60 * 1000)).toFixed(2),
              minRunHours: config.runtime.minRunHours,
            },
            'Minimum runtime met, shutting down...'
          );
          stopPeriodicIpRotation();
          cleanupWorkers();
          stopContinuousTesting();
          stopSpeedTestService();
          stopHourlySummaryService();
          stopDailyAggregationService();
          stopDuplicateIpSnapshotService();
          // Flush any pending batch writes before shutdown
          void batchWriter.forceFlush().then(() => {
            void stopIpRotationTesting().then(() => {
              process.exit(0);
            });
          });
        } else {
          const remainingHours = (getRemainingTimeMs() / (60 * 60 * 1000)).toFixed(2);
          logger.debug(
            {
              elapsedHours: ((Date.now() - startTime) / (60 * 60 * 1000)).toFixed(2),
              remainingHours,
              minRunHours: config.runtime.minRunHours,
            },
            `Runtime monitor: ${remainingHours} hours remaining until minimum runtime`
          );
        }
      }, config.runtime.monitorCheckIntervalMs);
    } else {
      logger.info(
        'Infinite mode: Will run indefinitely until manually stopped (SIGINT/SIGTERM)'
      );
    }

    logger.info('XProxy Tester Application Running - Testing devices every 5 seconds');
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      'Application failed'
    );
    process.exit(1);
  }
}

// Run the application
void main();
