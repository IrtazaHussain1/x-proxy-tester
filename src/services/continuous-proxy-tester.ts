/**
 * Continuous Proxy Tester Service
 * 
 * This service orchestrates continuous testing of all proxies from the XProxy Portal.
 * It manages:
 * - Device fetching and caching (refreshes every 6 hours)
 * - Continuous testing of each device (every 5 seconds)
 * - IP rotation detection and tracking
 * - Database persistence of all test results
 * - Stability calculation coordination
 * 
 * @module services/continuous-proxy-tester
 */

import { getAllDevices, updateDevices } from '../helpers/devices';
import { testProxyWithStats } from '../helpers/test-proxy';
import { logger } from '../lib/logger';
import { prisma } from '../lib/db';
import { startStabilityCalculation } from './stability-calculator';
import { config } from '../config';
import type { Device, ProxyMetrics, RequestStatus, RotationStatus } from '../types';

/**
 * Module-level state management
 * - deviceIntervals: Map of device IDs to their timeout handlers
 * - deviceTestingFlags: Map of device IDs to flags indicating if test is in progress
 * - lastDevicesFetch: Timestamp of last device list refresh
 * - isRunning: Flag indicating if continuous testing is active
 * - stabilityInterval: Interval handler for stability calculations
 * - refreshInterval: Interval handler for device list refresh
 */
let deviceIntervals = new Map<string, ReturnType<typeof setTimeout>>();
let deviceTestingFlags = new Map<string, boolean>(); // Track if device is currently being tested
let lastDevicesFetch: Date | null = null;
let isRunning = false;
let stabilityInterval: NodeJS.Timeout | null = null;
let refreshInterval: NodeJS.Timeout | null = null;

/**
 * Maps ProxyMetrics error types to database RequestStatus values
 * 
 * @param metrics - Proxy metrics from test request
 * @returns RequestStatus for database storage
 * 
 * @example
 * ```typescript
 * const status = mapToRequestStatus({ success: false, errorType: 'TIMEOUT' });
 * // Returns: 'TIMEOUT'
 * ```
 */
function mapToRequestStatus(metrics: ProxyMetrics): RequestStatus {
  if (metrics.success) {
    return 'SUCCESS';
  }
  switch (metrics.errorType) {
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'CONNECTION_REFUSED':
    case 'CONNECTION_RESET':
      return 'CONNECTION_ERROR';
    case 'HTTP_ERROR':
      return 'HTTP_ERROR';
    case 'DNS_ERROR':
      return 'DNS_ERROR';
    default:
      return 'OTHER';
  }
}

/**
 * Saves proxy test metrics to database with rotation tracking
 * 
 * This function:
 * 1. Creates or updates the proxy record
 * 2. Detects IP rotation by comparing current IP with previous IP
 * 3. Tracks rotation count and last rotation timestamp
 * 4. Flags proxies that don't rotate after threshold attempts
 * 5. Saves test request to database in a transaction
 * 
 * @param device - Device object with proxy credentials and metadata
 * @param metrics - Test metrics including response time, status, and outbound IP
 * 
 * @throws Logs errors but doesn't throw to prevent test cycle interruption
 * 
 * @example
 * ```typescript
 * await saveProxyTestToDatabase(device, {
 *   success: true,
 *   outboundIp: '1.2.3.4',
 *   responseTimeMs: 1500,
 *   // ... other metrics
 * });
 * ```
 */
async function saveProxyTestToDatabase(
  device: Device,
  metrics: ProxyMetrics
): Promise<void> {
  try {
    // Expected IP is the device's IP address
    const expectedIp = device.ip_address;

    // Check if IP changed from previous request (rotation detection)
    // Compare current outbound IP with last recorded IP
    const hasCurrentIp = metrics.outboundIp !== undefined && metrics.outboundIp !== null;

    // Find or create proxy record using device_id as primary key
    let proxy = await prisma.proxy.findUnique({
      where: { deviceId: device.device_id },
    });

    if (!proxy) {
      // Create new proxy record with device_id as primary key
      proxy = await prisma.proxy.create({
        data: {
          deviceId: device.device_id,
          name: device.name,
          location: device.state || device.city || null,
          host: device.relay_server_ip_address,
          port: device.port,
          protocol: 'http',
          username: device.username,
          password: device.password,
          active: true,
          lastIp: metrics.outboundIp || null,
          sameIpCount: hasCurrentIp ? 1 : 0,
          rotationStatus: 'OK',
          lastRotationAt: null,
          rotationCount: 0,
        },
      });
    } else {
      // Update proxy info if needed
      await prisma.proxy.update({
        where: { deviceId: device.device_id },
        data: {
          name: device.name,
          location: device.state || device.city || null,
          host: device.relay_server_ip_address,
          port: device.port,
          username: device.username,
          password: device.password,
        },
      });
    }

    // Check if IP changed from previous request (rotation detection)
    const hasPreviousIp = proxy.lastIp !== null && proxy.lastIp !== undefined;
    
    // IP changed if we have both IPs and they're different
    const ipChangedFromPrevious = 
      hasPreviousIp && 
      hasCurrentIp &&
      proxy.lastIp !== metrics.outboundIp;
    
    // Get rotation threshold from config
    const rotationThreshold = config.testing.rotationThreshold;
    
    // Track consecutive requests with same IP
    let sameIpCount: number;
    let rotationStatus: RotationStatus;
    let lastRotationAt: Date | null = null;
    let rotationCount: number = proxy.rotationCount || 0;
    
    if (!hasCurrentIp) {
      // No IP returned - can't determine rotation
      sameIpCount = proxy.sameIpCount || 0;
      rotationStatus = (proxy.rotationStatus as RotationStatus) || 'Unknown';
      lastRotationAt = proxy.lastRotationAt || null;
      // rotationCount stays the same
    } else if (!hasPreviousIp) {
      // First request with IP - start counting
      sameIpCount = 1;
      rotationStatus = 'OK'; // First IP, can't determine rotation yet
      lastRotationAt = null; // No rotation yet
      // rotationCount stays 0 (first IP, not a rotation)
    } else if (ipChangedFromPrevious) {
      // IP changed - rotation detected, reset counter
      sameIpCount = 1; // Start counting from 1 (this is the first request with new IP)
      rotationStatus = 'OK'; // Reset to OK when rotation is detected
      lastRotationAt = new Date(); // Record rotation timestamp
      rotationCount = (proxy.rotationCount || 0) + 1; // Increment rotation count
    } else {
      // Same IP as previous - increment counter
      sameIpCount = (proxy.sameIpCount || 0) + 1;
      
      // Flag as NoRotation if IP hasn't changed after threshold attempts
      rotationStatus = sameIpCount >= rotationThreshold ? 'NoRotation' : 'OK';
      lastRotationAt = proxy.lastRotationAt || null; // Keep previous rotation timestamp
      // rotationCount stays the same
    }

    // Check if returned IP matches expected IP (device.ip_address)
    const ipMatchesExpected = 
      expectedIp !== undefined && 
      expectedIp !== null &&
      hasCurrentIp &&
      expectedIp === metrics.outboundIp;

    // Use transaction to ensure data consistency
    await prisma.$transaction([
      // Update proxy with latest IP info
      prisma.proxy.update({
        where: { deviceId: proxy.deviceId },
        data: {
          lastIp: metrics.outboundIp || null,
          sameIpCount,
          rotationStatus,
          lastRotationAt,
          rotationCount,
        },
      }),
      // Save the test request
      prisma.proxyRequest.create({
        data: {
          proxyId: proxy.deviceId,
          timestamp: metrics.timestamp,
          targetUrl: metrics.requestUrl,
          status: mapToRequestStatus(metrics),
          httpStatusCode: metrics.httpStatus || null,
          responseTimeMs: metrics.responseTimeMs,
          expectedIp: expectedIp || null,
          outboundIp: metrics.outboundIp || null,
          ipChanged: ipChangedFromPrevious, // Changed from previous request (rotation)
          errorType: metrics.errorType || null,
          errorMessage: metrics.errorMessage || null,
        },
      }),
    ]);

    // Log IP mismatch if expected and returned are different
    if (!ipMatchesExpected && expectedIp && metrics.outboundIp) {
      logger.warn(
        {
          deviceId: device.device_id,
          deviceName: device.name,
          expectedIp,
          returnedIp: metrics.outboundIp,
          ipChanged: ipChangedFromPrevious,
        },
        'IP mismatch: expected vs returned'
      );
    }

    // Log when proxy is flagged for no rotation
    if (rotationStatus === 'NoRotation' && proxy.rotationStatus !== 'NoRotation') {
      logger.warn(
        {
          deviceId: device.device_id,
          deviceName: device.name,
          sameIpCount,
          rotationThreshold,
          lastIp: metrics.outboundIp,
        },
        `⚠️ Proxy flagged: IP has not changed after ${sameIpCount} attempts (threshold: ${rotationThreshold})`
      );
    }

    // Log when rotation is detected after being flagged
    if (ipChangedFromPrevious && proxy.rotationStatus === 'NoRotation') {
      logger.info(
        {
          deviceId: device.device_id,
          deviceName: device.name,
          previousIp: proxy.lastIp,
          newIp: metrics.outboundIp,
          rotationCount,
          lastRotationAt: lastRotationAt?.toISOString(),
        },
        '✅ Rotation detected: IP changed, status reset to OK'
      );
    }
    
    // Log when rotation is detected (general case)
    if (ipChangedFromPrevious) {
      logger.debug(
        {
          deviceId: device.device_id,
          deviceName: device.name,
          previousIp: proxy.lastIp,
          newIp: metrics.outboundIp,
          rotationCount,
          lastRotationAt: lastRotationAt?.toISOString(),
        },
        'IP rotation detected'
      );
    }
  } catch (error) {
    logger.error(
      {
        deviceId: device.device_id,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to save proxy test to database'
    );
  }
}

/**
 * Tests a single device through its proxy and saves results to database
 * 
 * This is the core test function that:
 * 1. Makes HTTP request through device proxy
 * 2. Collects metrics (response time, IP, status)
 * 3. Persists results to database
 * 
 * @param device - Device to test
 * 
 * @example
 * ```typescript
 * await testAndSaveDevice({
 *   device_id: 'abc123',
 *   name: 'Device1',
 *   // ... other device fields
 * });
 * ```
 */
async function testAndSaveDevice(device: Device): Promise<void> {
  try {
    const metrics = await testProxyWithStats(device);
    await saveProxyTestToDatabase(device, metrics);
  } catch (error) {
    logger.error(
      {
        deviceId: device.device_id,
        deviceName: device.name,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to test device'
    );
  }
}

/**
 * Starts continuous testing loop for a single device
 * 
 * Testing pattern:
 * 1. Run test immediately
 * 2. Wait for test to complete
 * 3. Wait configured interval (default: 5 seconds) AFTER completion
 * 4. Repeat from step 1
 * 
 * This ensures exactly N seconds between the END of one test and START of next test.
 * Each device runs independently with its own interval.
 * 
 * Prevents multiple concurrent test loops for the same device by checking a flag.
 * 
 * @param device - Device to start testing
 * 
 * @example
 * ```typescript
 * startDeviceTesting(device);
 * // Device will now be tested every 5 seconds continuously
 * ```
 */
function startDeviceTesting(device: Device): void {
  const deviceId = device.device_id;

  // If already testing, don't start another loop
  if (deviceTestingFlags.get(deviceId)) {
    logger.debug({ deviceId }, 'Device testing already in progress, skipping start');
    return;
  }

  // Stop existing interval if any (safety check)
  stopDeviceTesting(deviceId);

  // Mark device as being tested
  deviceTestingFlags.set(deviceId, true);

  // Test immediately, then wait 5 seconds after completion before next test
  async function runTestWithInterval(): Promise<void> {
    // Check if we should continue (device might have been stopped)
    if (!deviceTestingFlags.get(deviceId)) {
      logger.debug({ deviceId }, 'Device testing stopped, exiting loop');
      return;
    }

    const testStartTime = Date.now();
    
    try {
      // Run the test and wait for it to complete
      await testAndSaveDevice(device);
    } catch (error) {
      logger.error(
        {
          deviceId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Error in device test cycle'
      );
    }
    
    // Check again if we should continue after test
    if (!deviceTestingFlags.get(deviceId)) {
      logger.debug({ deviceId }, 'Device testing stopped after test, exiting loop');
      return;
    }
    
    // Calculate test duration
    const testDuration = Date.now() - testStartTime;
    
    // Wait exactly configured interval AFTER the request completes
    // This ensures: Request 1 completes → Wait interval → Request 2 starts
    const waitTime = config.testing.intervalMs;
    
    logger.debug(
      {
        deviceId,
        deviceName: device.name,
        testDurationMs: testDuration,
        waitTimeMs: waitTime,
      },
      `Test completed in ${testDuration}ms, waiting ${waitTime}ms before next test`
    );
    
    // Wait configured interval, then schedule next test
    const timeoutId = setTimeout(() => {
      // Clear the stored timeout ID before starting next iteration
      deviceIntervals.delete(deviceId);
      // Recursively call to continue the loop
      void runTestWithInterval();
    }, waitTime);
    
    // Store timeout ID for cleanup
    deviceIntervals.set(deviceId, timeoutId);
  }

  // Start the test cycle
  void runTestWithInterval();
}

/**
 * Stops continuous testing for a specific device
 * 
 * Clears the timeout interval, removes device from tracking map,
 * and sets the testing flag to false to prevent new test loops.
 * 
 * @param deviceId - Unique device identifier
 */
function stopDeviceTesting(deviceId: string): void {
  // Clear timeout if exists
  const timeoutId = deviceIntervals.get(deviceId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    deviceIntervals.delete(deviceId);
  }
  
  // Set flag to stop any running test loops
  deviceTestingFlags.set(deviceId, false);
  
  logger.debug({ deviceId }, 'Stopped device testing');
}

/**
 * Stops continuous testing for all devices
 * 
 * Clears all timeout intervals and empties the device intervals map.
 * Used during graceful shutdown.
 */
function stopAllDeviceTesting(): void {
  for (const [deviceId, timeoutId] of deviceIntervals.entries()) {
    clearTimeout(timeoutId);
    logger.debug({ deviceId }, 'Stopped testing device');
  }
  deviceIntervals.clear();
  deviceTestingFlags.clear();
}

/**
 * Gets all devices, refreshing cache if expired
 * 
 * Device list is cached in memory and refreshed:
 * - On first call (cache is empty)
 * - When cache is older than configured refresh interval (default: 6 hours)
 * 
 * @returns Array of all available devices
 * @throws Error if device refresh fails
 */
async function getDevicesWithRefresh(): Promise<Device[]> {
  const now = new Date();
  const shouldRefresh =
    !lastDevicesFetch ||
    now.getTime() - lastDevicesFetch.getTime() >= config.refresh.intervalMs;

  if (shouldRefresh) {
    logger.info('Refreshing devices cache (cache expired or first run)');
    try {
      await updateDevices();
      lastDevicesFetch = now;
      logger.info('Devices cache refreshed successfully');
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        'Failed to refresh devices cache'
      );
      throw error;
    }
  }

  return getAllDevices();
}

/**
 * Refreshes device testers based on current device list
 * 
 * This function:
 * 1. Fetches latest device list (with cache refresh if needed)
 * 2. Stops testing for devices that no longer exist
 * 3. Starts testing for newly added devices
 * 
 * Called:
 * - On initial startup
 * - Periodically at configured refresh interval (default: 6 hours)
 * 
 * @throws Error if device fetching fails
 */
async function refreshDeviceTesters(): Promise<void> {
  const devices = await getDevicesWithRefresh();
  const currentDeviceIds = new Set(devices.map((d) => d.device_id));

  // Stop testers for devices that no longer exist
  for (const deviceId of deviceIntervals.keys()) {
    if (!currentDeviceIds.has(deviceId)) {
      stopDeviceTesting(deviceId);
      logger.info({ deviceId }, 'Stopped testing removed device');
    }
  }

  // Start testers for new devices
  for (const device of devices) {
    if (!deviceIntervals.has(device.device_id)) {
      startDeviceTesting(device);
      logger.info({ deviceId: device.device_id, deviceName: device.name }, 'Started testing device');
    }
  }

  logger.info(
    {
      totalDevices: devices.length,
      activeTesters: deviceIntervals.size,
    },
    'Device testers refreshed'
  );
}

/**
 * Starts the continuous proxy testing system
 * 
 * This is the main entry point that:
 * 1. Fetches all devices and starts testing each one
 * 2. Sets up periodic device list refresh (default: every 6 hours)
 * 3. Starts stability calculation service (default: every 10 minutes)
 * 
 * Each device is tested independently every N seconds (default: 5 seconds).
 * Tests run continuously until `stopContinuousTesting()` is called.
 * 
 * @throws Error if initialization fails
 * 
 * @example
 * ```typescript
 * await startContinuousTesting();
 * // System is now testing all devices continuously
 * ```
 */
export async function startContinuousTesting(): Promise<void> {
  if (isRunning) {
    logger.warn('Continuous testing is already running');
    return;
  }

  isRunning = true;
  logger.info('Starting continuous proxy testing');

  try {
    // Initial device refresh and start testing
    await refreshDeviceTesters();

    // Refresh device list at configured interval
    refreshInterval = setInterval(() => {
      void refreshDeviceTesters();
    }, config.refresh.intervalMs);

    // Start stability calculation
    stabilityInterval = startStabilityCalculation();

    logger.info(
      {
        testIntervalMs: config.testing.intervalMs,
        refreshIntervalMs: config.refresh.intervalMs,
        activeDevices: deviceIntervals.size,
      },
      'Continuous testing started'
    );
  } catch (error) {
    isRunning = false;
    logger.error(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      'Failed to start continuous testing'
    );
    throw error;
  }
}

/**
 * Stops the continuous proxy testing system
 * 
 * Gracefully shuts down:
 * - Stops all device testing loops
 * - Clears device refresh interval
 * - Clears stability calculation interval
 * 
 * Safe to call multiple times (idempotent).
 * 
 * @example
 * ```typescript
 * stopContinuousTesting();
 * // All testing has stopped, intervals cleared
 * ```
 */
export function stopContinuousTesting(): void {
  if (!isRunning) {
    return;
  }

  isRunning = false;
  stopAllDeviceTesting();

  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }

  if (stabilityInterval) {
    clearInterval(stabilityInterval);
    stabilityInterval = null;
  }

  logger.info('Continuous testing stopped');
}

/**
 * Gets the current status of the continuous testing system
 * 
 * @returns Status object with:
 * - isRunning: Whether testing is currently active
 * - activeDevices: Number of devices being tested
 * - testIntervalMs: Interval between tests (in milliseconds)
 * 
 * @example
 * ```typescript
 * const status = getTestingStatus();
 * console.log(`Testing ${status.activeDevices} devices`);
 * ```
 */
export function getTestingStatus(): {
  isRunning: boolean;
  activeDevices: number;
  testIntervalMs: number;
} {
  return {
    isRunning,
    activeDevices: deviceIntervals.size,
    testIntervalMs: config.testing.intervalMs,
  };
}

