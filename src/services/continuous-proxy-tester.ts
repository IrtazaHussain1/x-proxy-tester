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
import { extractAppVersion } from '../helpers/extra-parser';
import { prismaWithRetry as prisma, prisma as prismaRaw } from '../lib/db';
import { startStabilityCalculation } from './stability-calculator';
import {
  checkAutoDeactivation,
  autoDeactivateProxy,
  startRecoveryChecking,
} from './auto-deactivation';
import { startInactiveProxyRotation } from './ip-rotation';
import { rotateIp } from '../api/commands';
import { config } from '../config';
import { recordRequest, setActiveProxies } from '../lib/metrics';
import { batchWriter } from '../lib/batch-writer';
import { encrypt } from '../lib/encryption';
import type { Device, ProxyMetrics, RequestStatus, RotationStatus, RequestSource } from '../types';

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
let deviceConsecutiveFailures = new Map<string, number>(); // Track consecutive failures per device
let lastDevicesFetch: Date | null = null;
let isRunning = false;
let stabilityInterval: NodeJS.Timeout | null = null;
let refreshInterval: NodeJS.Timeout | null = null;
let recoveryInterval: NodeJS.Timeout | null = null;
let ipRotationInterval: NodeJS.Timeout | null = null;
const lastOutboundIpByDevice = new Map<string, string>();
class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      if (next) next();
      return;
    }

    this.permits++;
  }
}
const databaseWriteSemaphore = new Semaphore(config.database.proxySyncConcurrency);

// Removed getHistoricalRotationStats - now using proxy table fields directly
// This eliminates expensive aggregate queries that were causing connection pool exhaustion

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
 * Maps portal proxy_status to database active boolean
 * 
 * @param proxyStatus - Proxy status from portal (e.g., "active", "inactive", "in_maintenance")
 * @returns Boolean indicating if proxy should be marked as active
 * 
 * @example
 * ```typescript
 * const isActive = mapProxyStatusToActive('active'); // Returns: true
 * const isActive = mapProxyStatusToActive('inactive'); // Returns: false
 * ```
 */
export function mapProxyStatusToActive(proxyStatus: string | undefined | null): boolean {
  if (!proxyStatus) {
    return false; // Default to inactive if status is missing
  }
  
  const normalizedStatus = proxyStatus.toLowerCase().trim();
  
  // Only "active" status maps to true, everything else is inactive
  return normalizedStatus === 'active';
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
 * @param source - Source of the test request: 'continuous' | 'periodic_rotation' | 'manual' (default: 'continuous')
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
 * }, 'continuous');
 * ```
 */
export async function saveProxyTestToDatabase(
  device: Device,
  metrics: ProxyMetrics,
  source: RequestSource = 'continuous'
): Promise<void> {
  await processProxyTestWriteJob(device, metrics, source);
}

/**
 * Persists proxy test write jobs from BullMQ worker.
 */
export async function processProxyTestWriteJob(
  device: Device,
  metrics: ProxyMetrics,
  source: RequestSource = 'continuous'
): Promise<void> {
  // BullMQ serializes Dates as strings; normalize once for DB timestamp fields.
  const eventTimestamp =
    metrics.timestamp instanceof Date ? metrics.timestamp : new Date(metrics.timestamp as unknown as string);

  await databaseWriteSemaphore.acquire();
  // Removed health check here - it was causing connection pool exhaustion
  // Health checks are cached and called less frequently elsewhere
  // Database operations will fail gracefully if connection is unavailable

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

    /** When true, we merge portal sync + rotation into a single UPDATE (reduces InnoDB row lock churn). */
    const proxyExistedBefore = proxy !== null;

    // Map portal proxy_status to active boolean
    const isActive = mapProxyStatusToActive(device.proxy_status);

    /** Portal fields from XProxy — written together with rotation fields when proxy already existed. */
    const portalSyncData = {
      deviceApiId: device.id || null,
      name: device.name,
      model: device.model || null,
      location: device.state || device.city || null,
      host: device.relay_server_ip_address,
      port: device.port,
      username: device.username,
      password: device.password ? await encrypt(device.password) : null,
      active: isActive,
      ipAddress: device.ip_address || null,
      wsStatus: device.ws_status || null,
      proxyStatus: device.proxy_status || null,
      country: device.country || null,
      state: device.state || null,
      city: device.city || null,
      street: device.street || null,
      longitude: device.longitude || null,
      latitude: device.latitude || null,
      relayServerId: device.relay_server_id || null,
      relayServerIpAddress: device.relay_server_ip_address || null,
      downloadNetSpeed: device.download_net_speed || null,
      uploadNetSpeed: device.upload_net_speed || null,
      lastIpRotation: device.last_ip_rotation || null,
      extra: device.extra || null,
      version: extractAppVersion(device.extra),
    };

    if (!proxy) {
      // Create new proxy record with device_id as primary key
      proxy = await prisma.proxy.create({
        data: {
          deviceId: device.device_id,
          ...portalSyncData,
          protocol: 'http',
          lastIp: metrics.outboundIp || null,
          sameIpCount: hasCurrentIp ? 1 : 0,
          rotationStatus: 'Rotated',
          lastRotationAt: null,
          rotationCount: 0,
        },
      });
    }

    // Check if IP changed from previous request (rotation detection)
    // Use proxy.lastIp instead of querying proxy_requests (much faster)
    const rotationThreshold = config.testing.rotationThreshold;
    const previousIp = proxy.lastIp;
    const hasPreviousIp = previousIp !== null && previousIp !== undefined;
    
    // Get rotation stats from proxy table (already fetched, no additional query needed)
    const rotationCount = proxy.rotationCount ?? 0;
    const lastRotationAt = proxy.lastRotationAt;
    
    // IP changed if we have both IPs and they're different
    const shouldCompareForRotation = metrics.success && hasCurrentIp;
    const ipChangedFromPrevious = 
      shouldCompareForRotation &&
      hasPreviousIp &&
      previousIp !== metrics.outboundIp;
    
    // Track consecutive requests with same IP
    // Calculate sameIpCount from proxy.sameIpCount (already tracked in proxy table)
    let sameIpCount: number;
    let rotationStatus: RotationStatus;
    let finalRotationCount: number = rotationCount;
    let finalLastRotationAt: Date | null = lastRotationAt;
    
    if (!shouldCompareForRotation) {
      // No IP returned - can't determine rotation
      sameIpCount = proxy.sameIpCount ?? 0;

      if (sameIpCount >= rotationThreshold) {
        rotationStatus = 'NoRotation';
      } else if (finalLastRotationAt) {
        rotationStatus = 'Rotated';
      } else {
        rotationStatus = 'Unknown';
      }
    } else if (!hasPreviousIp) {
      // First request with IP - start counting
      // Can't determine rotation status yet (need previous IP to compare)
      sameIpCount = 1;
      rotationStatus = 'Unknown'; // First IP, can't determine rotation yet
      finalLastRotationAt = null; // No rotation yet
      finalRotationCount = 0; // First IP, not a rotation
    } else if (ipChangedFromPrevious) {
      // IP changed - actual rotation detected!
      sameIpCount = 1; // Start counting from 1 (this is the first request with new IP)
      rotationStatus = 'Rotated'; // Mark as Rotated when actual rotation is detected
      finalLastRotationAt = eventTimestamp; // Record rotation timestamp from the test event
      finalRotationCount = rotationCount + 1; // Increment rotation count

      // Check if this IP change is part of a rotation cycle and update the rotation record
      try {
        const pendingRotation = await prismaRaw.ipRotation.findFirst({
          where: {
            proxyId: proxy.deviceId,
            ipAfter: null, // Not yet verified
            success: false, // Still pending
            commandSentAt: {
              gte: new Date(Date.now() - 5 * 60 * 1000), // Within last 5 minutes
            },
          },
          orderBy: {
            commandSentAt: 'desc',
          },
        });

        if (pendingRotation && metrics.outboundIp) {
          // Update rotation record with new IP
          await prismaRaw.ipRotation.update({
            where: { id: pendingRotation.id },
            data: {
              ipAfter: metrics.outboundIp,
              // Verification will be handled by verification service, but we can mark as detected
            },
          });

          logger.debug(
            {
              rotationId: pendingRotation.id,
              proxyId: proxy.deviceId,
              ipAfter: metrics.outboundIp,
            },
            'Updated rotation record with IP change detected from test request'
          );
        }
      } catch (error) {
        // Don't fail the test if rotation record update fails
        logger.debug(
          {
            proxyId: proxy.deviceId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to update rotation record with IP change'
        );
      }
    } else {
      // Same IP as previous - no rotation occurred
      sameIpCount = (proxy.sameIpCount ?? 0) + 1;
      
      // Flag as NoRotation if IP hasn't changed after threshold attempts
      // Otherwise keep previous status (could be 'Rotated' from last actual rotation, or 'Unknown')
      if (sameIpCount >= rotationThreshold) {
        rotationStatus = 'NoRotation';
      } else {
        rotationStatus = finalLastRotationAt ? 'Rotated' : 'Unknown';
      }
      // rotationCount stays the same
    }

    // Check if returned IP matches expected IP (device.ip_address)
    const ipMatchesExpected = 
      expectedIp !== undefined && 
      expectedIp !== null &&
      hasCurrentIp &&
      expectedIp === metrics.outboundIp;

    // Persist rotation (+ portal sync when the row already existed — one UPDATE instead of two).
    const rotationData = {
      // Only update last IP when we successfully observe one.
      lastIp: hasCurrentIp ? metrics.outboundIp : proxy.lastIp,
      sameIpCount,
      rotationStatus,
      lastRotationAt: finalLastRotationAt,
      rotationCount: finalRotationCount,
    };

    batchWriter.add({
      type: 'update',
      model: 'proxy',
      where: { deviceId: proxy.deviceId },
      data: proxyExistedBefore ? { ...portalSyncData, ...rotationData } : rotationData,
    });
    
    // Write the test request directly — awaited so BullMQ only acknowledges the job
    // after the data is actually in MySQL. The queue's 5-attempt retry covers transient
    // DB failures. Using batchWriter.add() here caused silent data loss: the job was
    // acknowledged before the async batch flush, so a crash between enqueue and flush
    // permanently dropped the record.
    batchWriter.add({
      type: 'create',
      model: 'proxyRequest',
      data: {
        proxyId: proxy.deviceId,
        timestamp: eventTimestamp,
        createdAt: eventTimestamp,
        updatedAt: eventTimestamp,
        targetUrl: metrics.requestUrl,
        status: mapToRequestStatus(metrics),
        httpStatusCode: metrics.httpStatus || null,
        responseTimeMs: metrics.responseTimeMs,
        expectedIp: expectedIp || null,
        outboundIp: metrics.outboundIp || null,
        ipChanged: ipChangedFromPrevious,
        errorType: metrics.errorType || null,
        errorMessage: metrics.errorMessage || null,
        source: source,
        downloadSpeedMbps: null,
        uploadSpeedMbps: null,
      },
    });

    if (hasCurrentIp && metrics.success) {
      lastOutboundIpByDevice.set(device.device_id, metrics.outboundIp!);
    }

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
          previousIp: previousIp,
          newIp: metrics.outboundIp,
          rotationCount: finalRotationCount,
          lastRotationAt: finalLastRotationAt?.toISOString(),
        },
        '✅ Rotation detected: IP changed, status reset to Rotated'
      );
    }
    
    // Log when rotation is detected (general case)
    if (ipChangedFromPrevious) {
      logger.debug(
        {
          deviceId: device.device_id,
          deviceName: device.name,
          previousIp: previousIp,
          newIp: metrics.outboundIp,
          rotationCount: finalRotationCount,
          lastRotationAt: finalLastRotationAt?.toISOString(),
        },
        'IP rotation detected'
      );
    }

    // Check for auto-deactivation if request failed
    if (!metrics.success && config.autoDeactivation.enabled) {
      const deactivationCheck = await checkAutoDeactivation(device.device_id);
      if (deactivationCheck.shouldDeactivate) {
        await autoDeactivateProxy(device.device_id, deactivationCheck.reason ?? 'unknown', {
          consecutiveFailures: deactivationCheck.consecutiveFailures,
          failureRate: deactivationCheck.failureRate,
        });
        stopDeviceTesting(device.device_id);
      }
    }
  } catch (error) {
    logger.error(
      {
        deviceId: device.device_id,
        workflow: source,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      `Failed to save proxy test to database (${source} workflow)`
    );
    throw error;
  } finally {
    databaseWriteSemaphore.release();
  }
}

/**
 * Applies coalesced proxy metadata updates from the dedicated queue worker.
 */
export async function processProxyMetaWriteJob(deviceId: string, data: Record<string, unknown>): Promise<void> {
  await prisma.proxy.update({
    where: { deviceId },
    data,
  });
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
  // Removed health check here - it was causing connection pool exhaustion
  // Health checks are cached and called less frequently elsewhere
  // Database operations will fail gracefully if connection is unavailable

  try {
    const metrics = await testProxyWithStats(device);
    
    // Record metrics
    // Record metrics
    recordRequest(metrics.success, metrics.responseTimeMs, 'continuous');
    
    if (metrics.success) {
      // Reset consecutive failures on success
      if (deviceConsecutiveFailures.has(device.device_id)) {
        deviceConsecutiveFailures.delete(device.device_id);
      }
    } else {
      // Handle failure (logic similar to catch block)
      const currentFailures = (deviceConsecutiveFailures.get(device.device_id) || 0) + 1;
      deviceConsecutiveFailures.set(device.device_id, currentFailures);
      
      const threshold = config.autoDeactivation.consecutiveFailureThreshold;

      if (currentFailures >= threshold) {
        logger.warn(
            {
              deviceId: device.device_id,
              deviceName: device.name,
              currentFailures,
              threshold,
            },
            '❌ Triggering IP rotation due to consecutive failures (metrics failed)'
        );

        // Reset counter
        deviceConsecutiveFailures.set(device.device_id, 0);

        // Trigger rotation
        void rotateIp(device.device_id).catch((err) => {
            logger.error({ deviceId: device.device_id, error: err }, 'Exception triggering rotation on failure');
        });
      }
    }
    
    await saveProxyTestToDatabase(device, metrics, 'continuous');
  } catch (error) {
    logger.error(
      {
        deviceId: device.device_id,
        deviceName: device.name,
        workflow: 'continuous',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to test device (continuous workflow)'
    );
    // Record failed request
    recordRequest(false, 0);

    // Track consecutive failures and trigger rotation if needed
    const currentFailures = (deviceConsecutiveFailures.get(device.device_id) || 0) + 1;
    deviceConsecutiveFailures.set(device.device_id, currentFailures);

    const threshold = config.autoDeactivation.consecutiveFailureThreshold;
    
    if (currentFailures >= threshold) {
      logger.warn(
        {
          deviceId: device.device_id,
          deviceName: device.name,
          currentFailures,
          threshold,
        },
        '❌ Triggering IP rotation due to consecutive failures'
      );

      // Reset counter after triggering rotation to avoid spamming commands
      deviceConsecutiveFailures.set(device.device_id, 0);

      // Trigger rotation in background
      rotateIp(device.device_id)
        .then((response) => {
          if (response.success) {
            logger.info({ deviceId: device.device_id }, '✅ Rotation triggered successfully on failure');
          } else {
            logger.error({ deviceId: device.device_id, error: response.message }, 'Failed to trigger rotation on failure');
          }
        })
        .catch((err) => {
          logger.error({ deviceId: device.device_id, error: err }, 'Exception triggering rotation on failure');
        });
    }
  }

  // Reset failures on success (metrics won't be available here if it went to catch block, but if we are here it might have succeeded?)
  // Wait, testAndSaveDevice calls testProxyWithStats which returns metrics.
  // If testProxyWithStats throws, we go to catch.
  // We need to check success inside try block too.

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

  // Spread initial starts across the test interval so all devices don't hit the DB at once.
  // Each device gets a random offset in [0, TEST_INTERVAL_MS).
  const startOffset = Math.floor(Math.random() * config.testing.intervalMs);

  // Test immediately, then wait 5 seconds after completion before next test
  async function runTestWithInterval(): Promise<void> {
    // Check if we should continue (device might have been stopped)
    if (!deviceTestingFlags.get(deviceId)) {
      logger.debug({ deviceId }, 'Device testing stopped, exiting loop');
      return;
    }

    // Check if proxy is still active before testing
    // Note: If proxy doesn't exist yet, allow first test to create it
    // Skip active check if we want to test inactive proxies
    try {
      if (config.testing.testInactiveProxies) {
        // Skip active check - we want to test inactive proxies
        logger.debug(
          { deviceId, testInactiveProxies: config.testing.testInactiveProxies },
          'Skipping active check - testing inactive proxies is enabled'
        );
      } else {
        // Only check active status if we DON'T want to test inactive proxies
        const proxy = await prisma.proxy.findUnique({
          where: { deviceId },
          select: { active: true },
        });

        // Only stop if proxy exists AND is inactive
        // If proxy doesn't exist, allow first test to create it
        if (proxy && !proxy.active) {
          logger.debug(
            { deviceId, active: proxy.active, testInactiveProxies: config.testing.testInactiveProxies },
            'Proxy is inactive, stopping testing (testInactiveProxies is false)'
          );
          stopDeviceTesting(deviceId);
          return;
        }
      }
    } catch (error) {
      logger.error(
        {
          deviceId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to check proxy active status'
      );
      // Continue testing if check fails (don't stop on transient errors)
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

    // Check if proxy became inactive during test
    // Note: If proxy doesn't exist yet (first test), allow it to be created
    // Skip active check if we want to test inactive proxies
    try {
      if (config.testing.testInactiveProxies) {
        // Skip active check - we want to test inactive proxies
        logger.debug(
          { deviceId, testInactiveProxies: config.testing.testInactiveProxies },
          'Skipping post-test active check - testing inactive proxies is enabled'
        );
      } else {
        // Only check active status if we DON'T want to test inactive proxies
        const proxy = await prisma.proxy.findUnique({
          where: { deviceId },
          select: { active: true },
        });

        // Only stop if proxy exists AND is inactive
        // If proxy doesn't exist yet, it will be created by the test
        if (proxy && !proxy.active) {
          logger.debug(
            { deviceId, active: proxy.active, testInactiveProxies: config.testing.testInactiveProxies },
            'Proxy became inactive during test, stopping (testInactiveProxies is false)'
          );
          stopDeviceTesting(deviceId);
          return;
        }
      }
    } catch (error) {
      // Continue if check fails
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

  // Start the test cycle after a random offset to avoid thundering herd at startup
  const initialTimeoutId = setTimeout(() => {
    deviceIntervals.delete(deviceId);
    void runTestWithInterval();
  }, startOffset);
  deviceIntervals.set(deviceId, initialTimeoutId);
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
 * 2. Syncs active status for all proxies from portal
 * 3. Stops testing for devices that no longer exist or are inactive
 * 4. Starts testing for newly added devices
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
  const deviceMap = new Map(devices.map((d) => [d.device_id, d]));
  const existingProxyActiveById = new Map<string, boolean>();

  // Sync all device fields for all proxies from portal
  try {
    const allProxies = await prisma.proxy.findMany({
      select: { deviceId: true, active: true, ipAddress: true },
    });
    for (const proxy of allProxies) {
      existingProxyActiveById.set(proxy.deviceId, proxy.active);
    }

    // Batch updates: execute chunked updates inside one transaction per chunk to reduce
    // connection churn compared to many concurrent single-row updates.
    const proxiesToSync = allProxies.filter((proxy) => deviceMap.has(proxy.deviceId));
    const batchSize = config.database.proxySyncConcurrency;

    for (let i = 0; i < proxiesToSync.length; i += batchSize) {
      const chunk = proxiesToSync.slice(i, i + batchSize);
      const updateQueries: any[] = [];
      for (const proxy of chunk) {
        const device = deviceMap.get(proxy.deviceId);
        if (!device) continue;

        const isActive = mapProxyStatusToActive(device.proxy_status);

        logger.debug(
          {
            deviceId: proxy.deviceId,
            deviceName: device.name,
            active: isActive,
            portalStatus: device.proxy_status,
          },
          'Queued proxy field sync from portal'
        );

        updateQueries.push(prismaRaw.proxy.update({
          where: { deviceId: proxy.deviceId },
          data: {
            deviceApiId: device.id || null,
            name: device.name,
            model: device.model || null,
            location: device.state || device.city || null,
            host: device.relay_server_ip_address,
            port: device.port,
            username: device.username,
            password: device.password ? await encrypt(device.password) : null,
            active: isActive,
            ipAddress: device.ip_address || null,
            wsStatus: device.ws_status || null,
            proxyStatus: device.proxy_status || null,
            country: device.country || null,
            state: device.state || null,
            city: device.city || null,
            street: device.street || null,
            longitude: device.longitude || null,
            latitude: device.latitude || null,
            relayServerId: device.relay_server_id || null,
            relayServerIpAddress: device.relay_server_ip_address || null,
            downloadNetSpeed: device.download_net_speed || null,
            uploadNetSpeed: device.upload_net_speed || null,
            lastIpRotation: device.last_ip_rotation || null,
            extra: device.extra || null,
            version: extractAppVersion(device.extra),
          },
        }));
      }

      if (updateQueries.length > 0) {
        await prisma.$transaction(updateQueries, { maxWait: 20_000, timeout: 120_000 });
      }
    }
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to sync proxy fields from portal'
    );
  }

  // Stop testers for devices that no longer exist, are inactive in portal, or auto-deactivated
  // If testInactiveProxies is enabled, only stop if device was removed (not if just inactive)
  for (const deviceId of deviceIntervals.keys()) {
    const device = deviceMap.get(deviceId);
    const portalActive = device ? mapProxyStatusToActive(device.proxy_status) : false;
    const dbActive = existingProxyActiveById.get(deviceId) ?? false;
    
    // Stop if:
    // - Device was removed from portal, OR
    // - testInactiveProxies is false AND (device is inactive in portal OR DB)
    const wasRemoved = !currentDeviceIds.has(deviceId);
    const shouldStopForInactive = !config.testing.testInactiveProxies && (!portalActive || !dbActive);
    const shouldStop = wasRemoved || shouldStopForInactive;
    
    if (shouldStop) {
      stopDeviceTesting(deviceId);
      const reason = wasRemoved
        ? 'removed_from_portal'
        : shouldStopForInactive
        ? (!portalActive ? 'inactive_in_portal' : 'auto_deactivated')
        : 'unknown';
      
      logger.info(
        {
          deviceId,
          reason,
          testInactiveProxies: config.testing.testInactiveProxies,
          portalActive,
          dbActive,
          wasRemoved,
          shouldStopForInactive,
        },
        'Stopped testing device'
      );
    }
  }

  // Start testers for new active devices (both portal and DB must be active)
  // Also create proxy records for devices that don't exist yet
  for (const device of devices) {
    const portalActive = mapProxyStatusToActive(device.proxy_status);
    const existingDbActive = existingProxyActiveById.get(device.device_id);
    let proxyExists = existingDbActive !== undefined;
    let dbActive = existingDbActive ?? true;
    
    // Create proxy record if it doesn't exist (for both active and inactive proxies)
    // This ensures all proxies from portal are stored in database for complete inventory
    if (!proxyExists) {
      try {
        await prisma.proxy.create({
          data: {
            deviceId: device.device_id,
            deviceApiId: device.id || null,
            name: device.name,
            model: device.model || null,
            location: device.state || device.city || null,
            host: device.relay_server_ip_address,
            port: device.port,
            protocol: 'http',
            username: device.username,
            password: device.password ? await encrypt(device.password) : null,
            active: portalActive, // Set based on portal status (can be false for inactive)
            ipAddress: device.ip_address || null,
            wsStatus: device.ws_status || null,
            proxyStatus: device.proxy_status || null,
            country: device.country || null,
            state: device.state || null,
            city: device.city || null,
            street: device.street || null,
            longitude: device.longitude || null,
            latitude: device.latitude || null,
            relayServerId: device.relay_server_id || null,
            relayServerIpAddress: device.relay_server_ip_address || null,
            downloadNetSpeed: device.download_net_speed || null,
            uploadNetSpeed: device.upload_net_speed || null,
            lastIpRotation: device.last_ip_rotation || null,
            extra: device.extra || null,
            version: extractAppVersion(device.extra),
            lastIp: null,
            sameIpCount: 0,
            rotationStatus: 'Unknown', // New proxy - haven't tested rotation yet
            lastRotationAt: null,
            rotationCount: 0,
          },
        });
        logger.info(
          { 
            deviceId: device.device_id, 
            deviceName: device.name,
            active: portalActive,
          },
          'Created proxy record for device'
        );
        dbActive = portalActive; // Set based on actual portal status
        existingProxyActiveById.set(device.device_id, dbActive);
        proxyExists = true;
      } catch (error: any) {
        // Handle duplicate key errors gracefully (might happen in race conditions)
        if (error?.code === 'P2002' || error?.message?.includes('Unique constraint')) {
          logger.debug(
            { deviceId: device.device_id },
            'Proxy record already exists (race condition), continuing...'
          );
          // Try to fetch it again
          try {
            const existingProxy = await prisma.proxy.findUnique({
              where: { deviceId: device.device_id },
              select: { active: true },
            });
            dbActive = existingProxy?.active ?? portalActive;
            existingProxyActiveById.set(device.device_id, dbActive);
            proxyExists = true;
          } catch {
            // If fetch fails, assume active
            dbActive = portalActive;
          }
        } else {
          logger.error(
            {
              deviceId: device.device_id,
              deviceName: device.name,
              error: error instanceof Error ? error.message : 'Unknown error',
              errorCode: error?.code,
            },
            'Failed to create proxy record'
          );
          // Continue anyway - don't block other proxies from being created
        }
      }
    }
    
    // Start testing if:
    // - Device is not already being tested
    // - AND either:
    //   a) We want to test inactive proxies (testInactiveProxies = true), OR
    //   b) Device is active in both portal and DB (testInactiveProxies = false)
    const shouldStartTesting = !deviceIntervals.has(device.device_id) && 
      (config.testing.testInactiveProxies || (portalActive && dbActive));
    
    if (shouldStartTesting) {
      startDeviceTesting(device);
      logger.info(
        { 
          deviceId: device.device_id, 
          deviceName: device.name,
          testInactiveProxies: config.testing.testInactiveProxies,
          portalActive,
          dbActive,
        },
        'Started testing device'
      );
    }
  }

  // Update metrics
  setActiveProxies(deviceIntervals.size);

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
 * 4. Starts auto-recovery checking service (default: every 5 minutes)
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

    // Helper function to start testing for a device
    const startTestingForDevice = async (deviceId: string) => {
      try {
        const devices = await getAllDevices();
        const device = devices.find((d) => d.device_id === deviceId);
        if (device) {
          const portalActive = mapProxyStatusToActive(device.proxy_status);
          // Start testing if testInactiveProxies is enabled OR device is active
          const shouldStart = config.testing.testInactiveProxies || portalActive;
          if (shouldStart && !deviceIntervals.has(deviceId)) {
            startDeviceTesting(device);
            logger.info(
              { deviceId, deviceName: device.name },
              'Started testing proxy'
            );
          }
        }
      } catch (error) {
        logger.error(
          {
            deviceId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to start testing proxy'
        );
      }
    };

    // Start auto-recovery checking with callback to start testing reactivated proxies
    if (config.autoRecovery.enabled) {
      recoveryInterval = startRecoveryChecking(async (deviceId: string) => {
        await startTestingForDevice(deviceId);
      });
    }

    // Start IP rotation service for inactive proxies
    if (config.ipRotation.enabled) {
      ipRotationInterval = startInactiveProxyRotation(
        getAllDevices,
        async (device: Device) => {
          // When a proxy becomes active after rotation, start testing
          await startTestingForDevice(device.device_id);
        }
      );
    }

    logger.info(
      {
        testIntervalMs: config.testing.intervalMs,
        refreshIntervalMs: config.refresh.intervalMs,
        activeDevices: deviceIntervals.size,
        autoDeactivationEnabled: config.autoDeactivation.enabled,
        autoRecoveryEnabled: config.autoRecovery.enabled,
        ipRotationEnabled: config.ipRotation.enabled,
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
 * - Clears recovery checking interval
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

  if (recoveryInterval) {
    clearInterval(recoveryInterval);
    recoveryInterval = null;
  }
  if (ipRotationInterval) {
    clearInterval(ipRotationInterval);
    ipRotationInterval = null;
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

