/**
 * Testing Control API
 * Provides endpoints for manually controlling proxy testing.
 */

import { startContinuousTesting, stopContinuousTesting, getTestingStatus } from '../services/continuous-proxy-tester';
import { logger } from '../lib/logger';

export interface TestingStatusResponse {
  isRunning: boolean;
  activeDevices: number;
  testIntervalMs: number;
  message: string;
}

export interface TestingControlResponse {
  success: boolean;
  message: string;
  status?: TestingStatusResponse;
}

// Get current testing status (whether testing is running and how many devices are active)
export async function getTestingStatusHandler(): Promise<TestingStatusResponse> {
  const status = getTestingStatus();
  return {
    ...status,
    message: status.isRunning
      ? `Testing is active with ${status.activeDevices} devices`
      : 'Testing is stopped',
  };
}

// Start proxy testing - begins continuous testing of all active proxies
export async function startTestingHandler(): Promise<TestingControlResponse> {
  try {
    const currentStatus = getTestingStatus();
    
    // Prevent starting if already running
    if (currentStatus.isRunning) {
      return {
        success: false,
        message: 'Testing is already running',
        status: {
          ...currentStatus,
          message: `Testing is already active with ${currentStatus.activeDevices} devices`,
        },
      };
    }

    // Start the continuous testing service
    await startContinuousTesting();
    const newStatus = getTestingStatus();
    
    logger.info(
      {
        activeDevices: newStatus.activeDevices,
      },
      'Testing started via API'
    );

    return {
      success: true,
      message: 'Testing started successfully',
      status: {
        ...newStatus,
        message: `Testing started with ${newStatus.activeDevices} devices`,
      },
    };
  } catch (error) {
    logger.error({ error }, 'Failed to start testing via API');
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Failed to start testing',
    };
  }
}

// Stop proxy testing - stops all continuous testing loops
export async function stopTestingHandler(): Promise<TestingControlResponse> {
  try {
    const currentStatus = getTestingStatus();
    
    // Prevent stopping if already stopped
    if (!currentStatus.isRunning) {
      return {
        success: false,
        message: 'Testing is already stopped',
        status: {
          ...currentStatus,
          message: 'Testing is already stopped',
        },
      };
    }

    // Stop the continuous testing service
    stopContinuousTesting();
    const newStatus = getTestingStatus();
    
    logger.info('Testing stopped via API');

    return {
      success: true,
      message: 'Testing stopped successfully',
      status: {
        ...newStatus,
        message: 'Testing has been stopped',
      },
    };
  } catch (error) {
    logger.error({ error }, 'Failed to stop testing via API');
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Failed to stop testing',
    };
  }
}

