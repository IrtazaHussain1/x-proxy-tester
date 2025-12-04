/**
 * Main Application Entry Point
 * 
 * Starts continuous proxy testing with runtime management:
 * - Enforces minimum runtime (default: 72 hours)
 * - Supports infinite mode (runs until manually stopped)
 * - Monitors runtime and prevents shutdown before minimum hours
 * 
 * @module main
 */

import 'dotenv/config';
import { startContinuousTesting, stopContinuousTesting } from './services/continuous-proxy-tester';
import { logger } from './lib/logger';
import { config } from './config';

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

  /**
   * Check if minimum runtime has been met
   */
  function hasMetMinimumRuntime(): boolean {
    const elapsedMs = Date.now() - startTime;
    return elapsedMs >= minRunMs;
  }

  /**
   * Get remaining time until minimum runtime is met
   */
  function getRemainingTimeMs(): number {
    const elapsedMs = Date.now() - startTime;
    return Math.max(0, minRunMs - elapsedMs);
  }

  /**
   * Handle shutdown request with runtime check
   */
  function handleShutdownRequest(signal: string): void {
    if (shutdownRequested) {
      logger.warn('Shutdown already in progress, ignoring signal');
      return;
    }

    shutdownRequested = true;

    if (config.runtime.runMode === 'infinite') {
      // Infinite mode: allow immediate shutdown
      logger.info(`Received ${signal}, shutting down gracefully...`);
      stopContinuousTesting();
      process.exit(0);
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
        stopContinuousTesting();
        process.exit(0);
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

    // Start continuous testing
    await startContinuousTesting();

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
          stopContinuousTesting();
          process.exit(0);
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
