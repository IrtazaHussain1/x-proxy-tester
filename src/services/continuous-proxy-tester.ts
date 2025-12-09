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
import { prismaWithRetry as prisma, prisma as prismaRaw, checkDatabaseHealth } from '../lib/db';
import { startStabilityCalculation } from './stability-calculator';
import {
  // checkAutoDeactivation,
  // autoDeactivateProxy,
  startRecoveryChecking,
} from './auto-deactivation';
import { startInactiveProxyRotation } from './ip-rotation';
import { config } from '../config';
import { encrypt } from '../lib/encryption';
import { recordRequest, setActiveProxies } from '../lib/metrics';
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
let recoveryInterval: NodeJS.Timeout | null = null;
let ipRotationInterval: NodeJS.Timeout | null = null;

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
  // Check database connection before proceeding
  const dbHealth = await checkDatabaseHealth();
  if (!dbHealth.connected) {
    logger.error(
      {
        deviceId: device.device_id,
        error: dbHealth.error || 'Database not connected',
      },
      'Database not connected, skipping save operation'
    );
    return;
  }

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

    // Encrypt password before storage
    const encryptedPassword = device.password ? await encrypt(device.password) : null;

    // Map portal proxy_status to active boolean
    const isActive = mapProxyStatusToActive(device.proxy_status);

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
          password: encryptedPassword,
          active: isActive,
          lastIp: metrics.outboundIp || null,
          sameIpCount: hasCurrentIp ? 1 : 0,
          rotationStatus: 'Rotated',
          lastRotationAt: null,
          rotationCount: 0,
        },
      });
    } else {
      // Update proxy info including active status from portal
      await prisma.proxy.update({
        where: { deviceId: device.device_id },
        data: {
          name: device.name,
          location: device.state || device.city || null,
          host: device.relay_server_ip_address,
          port: device.port,
          username: device.username,
          password: encryptedPassword,
          active: isActive, // Sync active status from portal
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
      // Can't determine rotation status yet (need previous IP to compare)
      sameIpCount = 1;
      rotationStatus = 'Unknown'; // First IP, can't determine rotation yet
      lastRotationAt = null; // No rotation yet
      // rotationCount stays 0 (first IP, not a rotation)
    } else if (ipChangedFromPrevious) {
      // IP changed - actual rotation detected!
      sameIpCount = 1; // Start counting from 1 (this is the first request with new IP)
      rotationStatus = 'Rotated'; // Mark as Rotated when actual rotation is detected
      lastRotationAt = new Date(); // Record rotation timestamp
      rotationCount = (proxy.rotationCount || 0) + 1; // Increment rotation count
    } else {
      // Same IP as previous - no rotation occurred
      sameIpCount = (proxy.sameIpCount || 0) + 1;
      
      // Flag as NoRotation if IP hasn't changed after threshold attempts
      // Otherwise keep previous status (could be 'Rotated' from last actual rotation, or 'Unknown')
      if (sameIpCount >= rotationThreshold) {
        rotationStatus = 'NoRotation';
      } else {
        // Keep previous status - if it was 'Rotated', it means rotation is still healthy
        // (hasn't exceeded threshold yet since last rotation)
        const previousStatus = (proxy.rotationStatus as RotationStatus) || 'Unknown';
        
        // Fix inconsistency: if status is 'Rotated' but lastRotationAt is null, set to 'Unknown'
        // This handles old data where rotation was set without timestamp
        if (previousStatus === 'Rotated' && !proxy.lastRotationAt) {
          rotationStatus = 'Unknown';
          lastRotationAt = null;
        } else {
          rotationStatus = previousStatus;
          lastRotationAt = proxy.lastRotationAt || null; // Keep previous rotation timestamp
        }
      }
      // rotationCount stays the same
    }

    // Check if returned IP matches expected IP (device.ip_address)
    const ipMatchesExpected = 
      expectedIp !== undefined && 
      expectedIp !== null &&
      hasCurrentIp &&
      expectedIp === metrics.outboundIp;

    // Use transaction to ensure data consistency
    // Use callback form instead of array form to work properly with retry logic
    await prismaRaw.$transaction(async (tx) => {
      // Update proxy with latest IP info
      await tx.proxy.update({
        where: { deviceId: proxy.deviceId },
        data: {
          lastIp: metrics.outboundIp || null,
          sameIpCount,
          rotationStatus,
          lastRotationAt,
          rotationCount,
        },
      });
      
      // Save the test request
      await tx.proxyRequest.create({
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
      });
    });

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
        '✅ Rotation detected: IP changed, status reset to Rotated'
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

    // Check for auto-deactivation if request failed
    // if (!metrics.success && config.autoDeactivation.enabled) {
    //   const deactivationCheck = await checkAutoDeactivation(device.device_id);
    //   if (deactivationCheck.shouldDeactivate) {
    //     // await autoDeactivateProxy(device.device_id, deactivationCheck.reason || 'unknown', {
    //     //   consecutiveFailures: deactivationCheck.consecutiveFailures,
    //     //   failureRate: deactivationCheck.failureRate,
    //     // });
    //     // // Stop testing this device if it was auto-deactivated
    //     // stopDeviceTesting(device.device_id);
    //   }
    // }
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
  // Check database connection before testing
  const dbHealth = await checkDatabaseHealth();
  if (!dbHealth.connected) {
    logger.warn(
      {
        deviceId: device.device_id,
        error: dbHealth.error || 'Database not connected',
      },
      'Database not connected, skipping device test'
    );
    // Record failed request due to DB issue
    recordRequest(false, 0);
    return;
  }

  try {
    const metrics = await testProxyWithStats(device);
    
    // Record metrics
    recordRequest(metrics.success, metrics.responseTimeMs);
    
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
    // Record failed request
    recordRequest(false, 0);
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

    // Check if proxy is still active before testing
    // Note: If proxy doesn't exist yet, allow first test to create it
    try {
      const proxy = await prisma.proxy.findUnique({
        where: { deviceId },
        select: { active: true },
      });

      // Only stop if proxy exists AND is inactive
      // If proxy doesn't exist, allow first test to create it
      if (proxy && !proxy.active) {
        logger.debug(
          { deviceId, active: proxy.active },
          'Proxy is inactive, stopping testing'
        );
        stopDeviceTesting(deviceId);
        return;
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
    try {
      const proxy = await prisma.proxy.findUnique({
        where: { deviceId },
        select: { active: true },
      });

      // Only stop if proxy exists AND is inactive
      // If proxy doesn't exist yet, it will be created by the test
      if (proxy && !proxy.active) {
        logger.debug(
          { deviceId, active: proxy.active },
          'Proxy became inactive during test, stopping'
        );
        stopDeviceTesting(deviceId);
        return;
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

  // Sync active status for all proxies from portal
  try {
    const allProxies = await prisma.proxy.findMany({
      select: { deviceId: true, active: true },
    });

    const updatePromises = allProxies
      .filter((proxy) => {
        const device = deviceMap.get(proxy.deviceId);
        if (!device) return false;
        const isActive = mapProxyStatusToActive(device.proxy_status);
        // Only update if status changed to avoid unnecessary writes
        return proxy.active !== isActive;
      })
      .map(async (proxy) => {
        const device = deviceMap.get(proxy.deviceId);
        if (!device) return;
        
        const isActive = mapProxyStatusToActive(device.proxy_status);
        await prisma.proxy.update({
          where: { deviceId: proxy.deviceId },
          data: { active: isActive },
        });
        
        logger.info(
          {
            deviceId: proxy.deviceId,
            previousActive: proxy.active,
            newActive: isActive,
            portalStatus: device.proxy_status,
          },
          'Synced proxy active status from portal'
        );
      });

    await Promise.all(updatePromises);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to sync proxy active status from portal'
    );
  }

  // Stop testers for devices that no longer exist, are inactive in portal, or auto-deactivated
  for (const deviceId of deviceIntervals.keys()) {
    const device = deviceMap.get(deviceId);
    const portalActive = device ? mapProxyStatusToActive(device.proxy_status) : false;
    
    // Also check database active status (may be auto-deactivated)
    let dbActive = true;
    try {
      const proxy = await prisma.proxy.findUnique({
        where: { deviceId },
        select: { active: true },
      });
      dbActive = proxy?.active ?? false;
    } catch (error) {
      // If check fails, assume active to avoid stopping unnecessarily
    }
    
    if (!currentDeviceIds.has(deviceId) || !portalActive || !dbActive) {
      stopDeviceTesting(deviceId);
      logger.info(
        {
          deviceId,
          reason: !currentDeviceIds.has(deviceId)
            ? 'removed'
            : !portalActive
            ? 'inactive_in_portal'
            : 'auto_deactivated',
        },
        'Stopped testing device'
      );
    }
  }

  // Start testers for new active devices (both portal and DB must be active)
  // Also create proxy records for devices that don't exist yet
  for (const device of devices) {
    const portalActive = mapProxyStatusToActive(device.proxy_status);
    
    // Check if proxy exists in database
    let proxy = null;
    let dbActive = true;
    try {
      proxy = await prisma.proxy.findUnique({
        where: { deviceId: device.device_id },
        select: { active: true },
      });
      dbActive = proxy?.active ?? true; // Default to true if proxy doesn't exist yet
    } catch (error) {
      // If check fails, assume active
    }
    
    // Create proxy record if it doesn't exist (for both active and inactive proxies)
    // This ensures all proxies from portal are stored in database for complete inventory
    if (!proxy) {
      try {
        const encryptedPassword = device.password ? await encrypt(device.password) : null;
        await prisma.proxy.create({
          data: {
            deviceId: device.device_id,
            name: device.name,
            location: device.state || device.city || null,
            host: device.relay_server_ip_address,
            port: device.port,
            protocol: 'http',
            username: device.username,
            password: encryptedPassword,
            active: portalActive, // Set based on portal status (can be false for inactive)
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
    
    // Start testing if device is active in both portal and DB, and not already testing
    if (!deviceIntervals.has(device.device_id) && portalActive && dbActive) {
      startDeviceTesting(device);
      logger.info(
        { deviceId: device.device_id, deviceName: device.name },
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
          if (portalActive && !deviceIntervals.has(deviceId)) {
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

