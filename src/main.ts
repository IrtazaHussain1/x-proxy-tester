/**
 * Main Application Entry Point
 * Starts continuous proxy testing with runtime management.
 */

import 'dotenv/config';
import { startContinuousTesting, stopContinuousTesting } from './services/continuous-proxy-tester';
import { startIpRotationTesting, stopIpRotationTesting } from './services/ip-rotation-testing';
import { logger } from './lib/logger';
import { config } from './config';
import { startServer } from './server';
import { startPeriodicArchival } from './services/archival';
import {
  startAlertMonitoring,
  registerAlertHandler,
  consoleAlertHandler,
  createWebhookAlertHandler,
  createSlackAlertHandler,
} from './lib/monitoring';
import { initGrafanaViews } from './lib/init-grafana-views';
import { initDatabaseSchema } from './lib/init-db';
import { waitForDatabase } from './lib/db';
import { stopPeriodicIpRotation, cleanupWorkers } from './services/ip-rotation';

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
      void stopIpRotationTesting().then(() => {
        process.exit(0);
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
        void stopIpRotationTesting().then(() => {
          process.exit(0);
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

    // Initialize Grafana views (after database schema is ready)
    await initGrafanaViews();

    // Start continuous testing
    await startContinuousTesting();

    // Start IP rotation testing service (runs alongside continuous testing)
    if (config.ipRotationTesting.enabled) {
      startIpRotationTesting();
      logger.info(
        {
          rotationIntervalMs: config.ipRotationTesting.rotationIntervalMs,
          rotationIntervalMinutes: (config.ipRotationTesting.rotationIntervalMs / 60000).toFixed(1),
          testConcurrency: config.ipRotationTesting.testConcurrency,
        },
        'IP rotation testing service started'
      );
    } else {
      logger.info('IP rotation testing service is disabled');
    }

    // Start periodic data archival (if enabled)
    const archivalEnabled = process.env.ENABLE_ARCHIVAL !== 'false';
    const archivalIntervalMs = parseInt(process.env.ARCHIVAL_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);
    const retentionDays = parseInt(process.env.DATA_RETENTION_DAYS || '30', 10);
    
    if (archivalEnabled) {
      startPeriodicArchival(archivalIntervalMs, retentionDays);
      logger.info(
        {
          retentionDays,
          intervalHours: archivalIntervalMs / (60 * 60 * 1000),
        },
        'Periodic data archival enabled'
      );
    }

    // Set up alert monitoring
    const alertMonitoringEnabled = process.env.ENABLE_ALERT_MONITORING !== 'false';
    const alertIntervalMs = parseInt(process.env.ALERT_CHECK_INTERVAL_MS || '60000', 10);
    
    if (alertMonitoringEnabled) {
      // Register console handler (always enabled for logging)
      registerAlertHandler(consoleAlertHandler);

      // Register webhook handler if URL provided
      if (process.env.ALERT_WEBHOOK_URL) {
        registerAlertHandler(createWebhookAlertHandler(process.env.ALERT_WEBHOOK_URL));
        logger.info('Webhook alert handler registered');
      }

      // Register Slack handler if webhook URL provided
      if (process.env.SLACK_WEBHOOK_URL) {
        registerAlertHandler(createSlackAlertHandler(process.env.SLACK_WEBHOOK_URL));
        logger.info('Slack alert handler registered');
      }

      startAlertMonitoring(alertIntervalMs);
      logger.info(
        {
          intervalMs: alertIntervalMs,
          intervalSeconds: alertIntervalMs / 1000,
        },
        'Alert monitoring enabled'
      );
    }

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
          void stopIpRotationTesting().then(() => {
            process.exit(0);
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
