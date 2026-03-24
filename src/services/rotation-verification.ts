/**
 * Rotation Verification Service
 * 
 * Handles adaptive verification of IP rotations using both IP comparison
 * and status check methods with retry logic.
 * 
 * @module services/rotation-verification
 */

import { prismaWithRetry as prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { config } from '../config';
import { getDeviceById } from '../api/devices';
import { mapProxyStatusToActive } from './continuous-proxy-tester';
import { testProxyWithStats } from '../helpers/test-proxy';
import { getAllDevices } from '../helpers/devices';
import { saveProxyTestToDatabase } from './continuous-proxy-tester';
import { recordRequest } from '../lib/metrics';

export type VerificationMethod = 'ip_comparison' | 'status_check' | 'both' | 'none';

/**
 * Update device details in database if they have changed
 * Called AFTER ip_rotations record is updated to ensure status_before/status_after capture correct values
 * 
 * @param proxyId - Device ID (string)
 * @param statusAfter - Proxy status from API
 * @param wsStatusAfter - WebSocket status from API
 * @param rotationId - Rotation ID for logging context
 */
async function updateDeviceDetailsAfterRotation(
  proxyId: string,
  statusAfter: string | null,
  wsStatusAfter: string | null,
  rotationId: string
): Promise<void> {
  try {
    // Fetch current proxy state to compare
    const currentProxy = await prisma.proxy.findUnique({
      where: { deviceId: proxyId },
      select: {
        wsStatus: true,
        proxyStatus: true,
        active: true,
      },
    });

    if (!currentProxy) {
      logger.warn({ rotationId, proxyId }, 'Proxy not found - cannot update device details');
      return;
    }

    const updateData: any = {};
    let needsUpdate = false;

    // Check if ws_status changed
    if (wsStatusAfter !== null && wsStatusAfter !== undefined && currentProxy.wsStatus !== wsStatusAfter) {
      updateData.wsStatus = wsStatusAfter;
      needsUpdate = true;
    }

    // Check if proxy_status changed
    if (statusAfter !== null && statusAfter !== undefined && currentProxy.proxyStatus !== statusAfter) {
      updateData.proxyStatus = statusAfter;
      needsUpdate = true;
    }

    // Check if active status changed (based on proxy_status)
    const isActive = mapProxyStatusToActive(statusAfter);
    if (statusAfter !== null && statusAfter !== undefined && currentProxy.active !== isActive) {
      updateData.active = isActive;
      needsUpdate = true;
    }

    if (needsUpdate) {
      await prisma.proxy.update({
        where: { deviceId: proxyId },
        data: updateData,
      });

      logger.debug(
        {
          rotationId,
          proxyId,
          updatedFields: Object.keys(updateData),
          oldWsStatus: currentProxy.wsStatus,
          newWsStatus: updateData.wsStatus,
          oldProxyStatus: currentProxy.proxyStatus,
          newProxyStatus: updateData.proxyStatus,
          oldActive: currentProxy.active,
          newActive: updateData.active,
        },
        'Updated device details in database after rotation verification'
      );
    }
  } catch (updateError) {
    // Log but don't fail - device update is non-critical for rotation verification
    logger.warn(
      {
        rotationId,
        proxyId,
        error: updateError instanceof Error ? updateError.message : 'Unknown error',
      },
      'Failed to update device details in database (non-critical)'
    );
  }
}

/**
 * Make a proxy test request with specified source for rotation verification
 * 
 * This function makes requests for ALL proxies (both active and inactive) to verify
 * their status during rotation cycles. It does not filter by proxy status.
 * 
 * @param proxyId - Proxy device ID
 * @param source - Request source ('periodic_rotation' or 'continuous')
 * @returns Proxy metrics or null if failed
 */
async function makeVerificationProxyRequest(
  proxyId: string,
  source: 'periodic_rotation' | 'continuous' = 'periodic_rotation'
): Promise<{ outboundIp: string | null; success: boolean } | null> {
  try {
    const devices = await getAllDevices();
    const device = devices.find((d) => d.device_id === proxyId);
    
    if (!device) {
      logger.warn({ proxyId }, 'Device not found for verification request');
      return null;
    }

    // Make request regardless of proxy status (active or inactive)
    // This ensures we check the status of all proxies during rotation cycles
    const metrics = await testProxyWithStats(device);
    
    // Record metrics with correct source
    recordRequest(metrics.success, metrics.responseTimeMs, source);
    
    // Save to database with correct source
    await saveProxyTestToDatabase(device, metrics, source);
    
    logger.debug(
      {
        proxyId,
        deviceName: device.name,
        proxyStatus: device.proxy_status,
        source,
        success: metrics.success,
        outboundIp: metrics.outboundIp,
      },
      'Made verification proxy request (checking all proxies - active and inactive)'
    );
    
    return {
      outboundIp: metrics.outboundIp || null,
      success: metrics.success,
    };
  } catch (error) {
    logger.debug(
      {
        proxyId,
        source,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to make verification proxy request'
    );
    return null;
  }
}

/**
 * Verify rotation by comparing IP from test requests
 * Checks if IP changed in proxy_requests after rotation command
 * 
 * @param rotationId - Rotation record ID
 * @param cycleType - Type of rotation cycle ('periodic', 'inactive_proxy', 'manual')
 * @param makeRequest - Whether to make a new proxy request for verification (default: true for periodic cycles)
 */
async function verifyRotationByIpComparison(
  rotationId: string,
  cycleType?: string,
  makeRequest: boolean = false
): Promise<{
  success: boolean;
  ipAfter: string | null;
  method: VerificationMethod;
}> {
  try {
    const rotation = await prisma.ipRotation.findUnique({
      where: { id: rotationId },
      select: {
        proxyId: true,
        ipBefore: true,
        ipAfter: true,
        commandSentAt: true,
      },
    });

    if (!rotation) {
      return { success: false, ipAfter: null, method: 'none' };
    }

    // If ipAfter is already populated (by continuous tester), verify it's valid
    // IMPORTANT: Don't trust ipAfter if it was set too early - we need to verify with actual requests
    // Only trust ipAfter if:
    // 1. It's different from ipBefore (IP changed)
    // 2. There are recent successful requests with that IP after commandSentAt
    // This prevents false positives from early IP updates
    if (rotation.ipAfter && rotation.ipBefore && rotation.ipAfter !== rotation.ipBefore) {
      // Check if there are successful requests with this IP after the rotation command
      // This ensures the IP change is real and not from an old/incorrect update
      const successfulRequestsWithNewIp = await prisma.proxyRequest.findFirst({
        where: {
          proxyId: rotation.proxyId,
          timestamp: {
            gte: rotation.commandSentAt,
          },
          outboundIp: rotation.ipAfter,
          status: 'SUCCESS',
        },
        orderBy: {
          timestamp: 'desc',
        },
        select: {
          id: true,
          timestamp: true,
          source: true,
        },
      });

      if (successfulRequestsWithNewIp) {
        // Valid IP change confirmed by successful request
        logger.debug(
          {
            rotationId,
            proxyId: rotation.proxyId,
            ipBefore: rotation.ipBefore,
            ipAfter: rotation.ipAfter,
            confirmedByRequestAt: successfulRequestsWithNewIp.timestamp,
            requestSource: successfulRequestsWithNewIp.source,
          },
          'IP change confirmed by successful request - marking as success'
        );
        return { success: true, ipAfter: rotation.ipAfter, method: 'ip_comparison' };
      } else {
        // ipAfter is set but no successful requests confirm it - don't trust it
        logger.debug(
          {
            rotationId,
            proxyId: rotation.proxyId,
            ipBefore: rotation.ipBefore,
            ipAfter: rotation.ipAfter,
            commandSentAt: rotation.commandSentAt,
          },
          'ipAfter is set but no successful requests confirm it - re-checking with actual requests'
        );
        // Fall through to check actual requests below
      }
    } else if (rotation.ipAfter && rotation.ipBefore && rotation.ipAfter === rotation.ipBefore) {
      // IP is same - failure (rotation didn't work)
      logger.debug(
        {
          rotationId,
          proxyId: rotation.proxyId,
          ipBefore: rotation.ipBefore,
          ipAfter: rotation.ipAfter,
        },
        'IP did not change (ipAfter already populated but same as ipBefore) - rotation verification failed'
      );
      return { success: false, ipAfter: rotation.ipAfter, method: 'ip_comparison' };
    }

    // For periodic cycles, make a proxy request with source='periodic_rotation' if requested
    if (makeRequest && cycleType === 'periodic') {
      logger.debug(
        {
          rotationId,
          proxyId: rotation.proxyId,
          cycleType,
        },
        'Making proxy request with source=periodic_rotation for verification'
      );
      
      const requestResult = await makeVerificationProxyRequest(rotation.proxyId, 'periodic_rotation');
      
      if (requestResult && requestResult.outboundIp) {
        // IMPORTANT: Check if the request itself was successful
        // If request failed, we can't verify IP change
        if (!requestResult.success) {
          logger.debug(
            {
              rotationId,
              proxyId: rotation.proxyId,
              outboundIp: requestResult.outboundIp,
            },
            'Proxy request failed - cannot verify IP change'
          );
          return { success: false, ipAfter: requestResult.outboundIp, method: 'ip_comparison' };
        }
        
        const ipChanged = rotation.ipBefore !== null && requestResult.outboundIp !== rotation.ipBefore;
        
        // IP changed - rotation worked
        if (ipChanged) {
          return { success: true, ipAfter: requestResult.outboundIp, method: 'ip_comparison' };
        }
        
        // If IP is same but we have a new IP (first time seeing this IP), consider it success
        // This handles the case where we don't have a previous IP to compare
        if (!rotation.ipBefore) {
          return { success: true, ipAfter: requestResult.outboundIp, method: 'ip_comparison' };
        }
        
        // IP didn't change - this is a failure case
        // Same IP means rotation didn't work, even if request was successful
        logger.debug(
          {
            rotationId,
            proxyId: rotation.proxyId,
            ipBefore: rotation.ipBefore,
            ipAfter: requestResult.outboundIp,
          },
          'IP did not change - rotation verification failed'
        );
        return { success: false, ipAfter: requestResult.outboundIp, method: 'ip_comparison' };
      }
    }

    // Find proxy requests after rotation command
    // For periodic cycles, prefer requests with source='periodic_rotation'
    const whereClause: any = {
      proxyId: rotation.proxyId,
      timestamp: {
        gte: rotation.commandSentAt,
      },
      outboundIp: {
        not: null,
      },
    };

    // If this is a periodic cycle, prefer periodic_rotation source requests
    if (cycleType === 'periodic') {
      whereClause.source = 'periodic_rotation';
    }

    const requests = await prisma.proxyRequest.findMany({
      where: whereClause,
      orderBy: {
        timestamp: 'desc',
      },
      take: 10, // Check last 10 requests
      select: {
        outboundIp: true,
        timestamp: true,
        source: true,
        status: true, // Include status to check if request was successful
      },
    });

    // If no periodic_rotation requests found for periodic cycle, fall back to any requests
    let requestsToUse = requests;
    if (requests.length === 0 && cycleType === 'periodic') {
      const fallbackRequests = await prisma.proxyRequest.findMany({
        where: {
          proxyId: rotation.proxyId,
          timestamp: {
            gte: rotation.commandSentAt,
          },
          outboundIp: {
            not: null,
          },
        },
        orderBy: {
          timestamp: 'desc',
        },
        take: 10,
        select: {
          outboundIp: true,
          timestamp: true,
          source: true,
          status: true, // Include status to check if request was successful
        },
      });
      
      if (fallbackRequests.length > 0) {
        logger.debug(
          {
            rotationId,
            proxyId: rotation.proxyId,
            foundRequests: fallbackRequests.length,
            sources: fallbackRequests.map((r) => r.source),
          },
          'No periodic_rotation requests found, using fallback requests'
        );
        requestsToUse = fallbackRequests;
      }
    }

    if (requestsToUse.length === 0) {
      return { success: false, ipAfter: null, method: 'ip_comparison' };
    }

    // IMPORTANT: Only consider successful requests for IP comparison
    // Failed requests don't prove rotation worked
    const successfulRequests = requestsToUse.filter((r) => r.status === 'SUCCESS');
    
    if (successfulRequests.length === 0) {
      logger.debug(
        {
          rotationId,
          proxyId: rotation.proxyId,
          totalRequests: requestsToUse.length,
          commandSentAt: rotation.commandSentAt,
        },
        'No successful proxy requests found - cannot verify IP change'
      );
      return { success: false, ipAfter: requestsToUse[0]?.outboundIp || null, method: 'ip_comparison' };
    }

    // Use the MOST RECENT successful request for IP comparison
    // This ensures we're using the latest IP, not an older one that might have been set earlier
    const latestSuccessfulRequest = successfulRequests[0]; // Already sorted by timestamp desc
    const latestIp = latestSuccessfulRequest.outboundIp;
    const ipChanged = rotation.ipBefore !== null && latestIp !== rotation.ipBefore;

    // Log which request we're using for verification
    logger.info(
      {
        rotationId,
        proxyId: rotation.proxyId,
        commandSentAt: rotation.commandSentAt,
        requestTimestamp: latestSuccessfulRequest.timestamp,
        requestSource: latestSuccessfulRequest.source,
        requestStatus: latestSuccessfulRequest.status,
        ipBefore: rotation.ipBefore,
        ipAfter: latestIp,
        ipChanged,
        timeSinceCommandMs: latestSuccessfulRequest.timestamp.getTime() - rotation.commandSentAt.getTime(),
      },
      `Using most recent successful request for IP comparison: ${latestIp} (changed: ${ipChanged})`
    );

    // IMPORTANT: IP must have changed for rotation to be considered successful
    // Same IP means rotation didn't work, regardless of request success
    if (ipChanged && latestIp) {
      logger.info(
        {
          rotationId,
          proxyId: rotation.proxyId,
          ipBefore: rotation.ipBefore,
          ipAfter: latestIp,
          requestTimestamp: latestSuccessfulRequest.timestamp,
          timeSinceCommandMs: latestSuccessfulRequest.timestamp.getTime() - rotation.commandSentAt.getTime(),
        },
        'IP changed - rotation verification SUCCESS'
      );
      return { success: true, ipAfter: latestIp, method: 'ip_comparison' };
    }

    // If IP is same but we have a new IP (first time seeing this IP), consider it success
    // This handles the case where we don't have a previous IP to compare
    if (latestIp && !rotation.ipBefore) {
      logger.info(
        {
          rotationId,
          proxyId: rotation.proxyId,
          ipAfter: latestIp,
          requestTimestamp: latestSuccessfulRequest.timestamp,
        },
        'First IP detected (no ipBefore) - rotation verification SUCCESS'
      );
      return { success: true, ipAfter: latestIp, method: 'ip_comparison' };
    }

    // IP didn't change - this is a failure case
    // Even if we have an IP, if it's the same as before, rotation didn't work
    logger.warn(
      {
        rotationId,
        proxyId: rotation.proxyId,
        ipBefore: rotation.ipBefore,
        ipAfter: latestIp,
        ipChanged,
        requestTimestamp: latestSuccessfulRequest.timestamp,
        timeSinceCommandMs: latestSuccessfulRequest.timestamp.getTime() - rotation.commandSentAt.getTime(),
      },
      'IP did not change - rotation verification FAILED (same IP)'
    );
    return { success: false, ipAfter: latestIp, method: 'ip_comparison' };
  } catch (error) {
    logger.error(
      {
        rotationId,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to verify rotation by IP comparison'
    );
    return { success: false, ipAfter: null, method: 'none' };
  }
}

/**
 * Verify rotation by checking proxy status from API
 */
async function verifyRotationByStatusCheck(rotationId: string): Promise<{
  success: boolean;
  statusAfter: string | null;
  wsStatusAfter: string | null;
  method: VerificationMethod;
}> {
  let proxyId: string | null = null;
  
  try {
    const rotation = await prisma.ipRotation.findUnique({
      where: { id: rotationId },
      select: {
        proxyId: true,
        statusBefore: true,
      },
    });

    if (!rotation) {
      logger.warn({ rotationId }, 'Rotation record not found - cannot fetch status');
      return { success: false, statusAfter: null, wsStatusAfter: null, method: 'none' };
    }

    proxyId = rotation.proxyId;

    // Fetch deviceApiId (integer ID) from Proxy table - API expects integer ID, not string device_id
    const proxy = await prisma.proxy.findUnique({
      where: { deviceId: rotation.proxyId },
      select: { deviceApiId: true },
    });

    if (!proxy || !proxy.deviceApiId) {
      logger.warn(
        {
          rotationId,
          proxyId: rotation.proxyId,
        },
        'Proxy not found or deviceApiId missing - cannot fetch status from API'
      );
      return { success: false, statusAfter: null, wsStatusAfter: null, method: 'none' };
    }

    logger.debug(
      {
        rotationId,
        proxyId: rotation.proxyId,
        deviceApiId: proxy.deviceApiId,
        statusBefore: rotation.statusBefore,
      },
      'Fetching device status from API for verification'
    );

    // Always try to fetch status from API - even if verification fails, we want to log the current state
    // Use deviceApiId (integer) instead of proxyId (string device_id)
    const device = await getDeviceById(proxy.deviceApiId);
    
    // Explicitly handle undefined vs null - preserve empty strings if they exist
    const statusAfter = device.proxy_status !== undefined 
      ? (device.proxy_status || null)  // Convert empty string to null, but keep other values
      : null;
    
    const wsStatusAfter = device.ws_status !== undefined
      ? (device.ws_status || null)  // Convert empty string to null, but keep other values
      : null;
    
    const isActive = mapProxyStatusToActive(statusAfter);

    // IMPORTANT: Check if there are successful proxy requests after rotation command
    // API status alone is not enough - we need actual successful proxy requests to confirm proxy is working
    // Fetch commandSentAt from rotation record (rotation variable already exists but doesn't have commandSentAt)
    const rotationWithCommandTime = await prisma.ipRotation.findUnique({
      where: { id: rotationId },
      select: {
        commandSentAt: true,
      },
    });

    if (!rotationWithCommandTime) {
      logger.warn({ rotationId }, 'Rotation record not found for successful request check');
      return { success: false, statusAfter, wsStatusAfter, method: 'status_check' };
    }

    // Check for successful proxy requests after rotation command
    const successfulRequests = await prisma.proxyRequest.findMany({
      where: {
        proxyId: rotation.proxyId,
        timestamp: {
          gte: rotationWithCommandTime.commandSentAt,
        },
        status: 'SUCCESS', // Only successful requests
      },
      take: 1, // We just need to know if at least one exists
      select: {
        id: true,
        timestamp: true,
        source: true,
      },
    });

    const hasSuccessfulRequests = successfulRequests.length > 0;

    logger.debug(
      {
        rotationId,
        proxyId: rotation.proxyId,
        statusBefore: rotation.statusBefore,
        statusAfter,
        wsStatusAfter,
        isActive,
        hasSuccessfulRequests,
        successfulRequestCount: successfulRequests.length,
        deviceProxyStatus: device.proxy_status,
        deviceWsStatus: device.ws_status,
        deviceHasProxyStatus: 'proxy_status' in device,
        deviceHasWsStatus: 'ws_status' in device,
      },
      'Status check result - checking API status and successful proxy requests'
    );

    // Success requires BOTH:
    // 1. API status is active (proxy_status === 'active')
    // 2. At least one successful proxy request exists (proxy is actually working)
    // This ensures we don't mark as successful if API says active but all requests are failing
    const success = isActive && hasSuccessfulRequests;

    if (isActive && !hasSuccessfulRequests) {
      logger.warn(
        {
          rotationId,
          proxyId: rotation.proxyId,
          statusAfter,
          isActive,
          hasSuccessfulRequests,
        },
        'API status is active but no successful proxy requests found - marking verification as failed'
      );
    }

    return {
      success,
      statusAfter,  // Always return the actual status value, even if success = false
      wsStatusAfter,  // Always return the actual ws_status value, even if success = false
      method: 'status_check',
    };
  } catch (error) {
    // Even if API call fails, try to get proxyId from rotation record to log it
    if (!proxyId) {
      try {
        const rotation = await prisma.ipRotation.findUnique({
          where: { id: rotationId },
          select: { proxyId: true },
        });
        proxyId = rotation?.proxyId || null;
      } catch {
        // Ignore - we'll just log without proxyId
      }
    }

    logger.error(
      {
        rotationId,
        proxyId,
        error: error instanceof Error ? error.message : 'Unknown error',
        errorStack: error instanceof Error ? error.stack : undefined,
      },
      'Failed to fetch device status from API - status values will be null'
    );
    
    // Return null values but log that we tried - this is a log table, so we record the failure
    return { success: false, statusAfter: null, wsStatusAfter: null, method: 'none' };
  }
}

/**
 * Verify rotation using both methods
 * 
 * @param rotationId - Rotation record ID
 * @param cycleType - Type of rotation cycle ('periodic', 'inactive_proxy', 'manual')
 * @param makeRequest - Whether to make a new proxy request for verification (default: true for periodic cycles)
 */
async function verifyRotationByBoth(
  rotationId: string,
  cycleType?: string,
  makeRequest: boolean = false
): Promise<{
  success: boolean;
  ipAfter: string | null;
  statusAfter: string | null;
  wsStatusAfter: string | null;
  method: VerificationMethod;
}> {
  const [ipResult, statusResult] = await Promise.all([
    verifyRotationByIpComparison(rotationId, cycleType, makeRequest),
    verifyRotationByStatusCheck(rotationId),
  ]);

  // IMPORTANT: Success is ONLY based on IP change - nothing else
  // The source of successful rotation is ONLY that the IP is changed
  // 
  // This ensures we don't mark as successful if:
  // - IP didn't change (rotation didn't work) - even if status is active and requests are successful
  // - All proxy requests are failing (proxy not working)
  //
  // Success case:
  // - IP changed (rotation worked) - this is the ONLY indicator of success
  
  // Success ONLY if IP changed - no other conditions
  const success = ipResult.success;
  
  const method: VerificationMethod = success
    ? ipResult.success && statusResult.success
      ? 'both'
      : 'ip_comparison'  // If success, it's always from IP comparison
    : 'both';

  logger.debug(
    {
      rotationId,
      ipResultSuccess: ipResult.success,
      statusResultSuccess: statusResult.success,
      finalSuccess: success,
      method,
      ipAfter: ipResult.ipAfter,
      ipBefore: ipResult.ipAfter ? 'checking...' : null,
    },
    `Verification result: IP changed=${ipResult.success} (ONLY source of success), Final=${success}`
  );

  // Log warning if status check says active but IP didn't change
  if (!success && statusResult.success) {
    logger.warn(
      {
        rotationId,
        ipResultSuccess: ipResult.success,
        statusResultSuccess: statusResult.success,
        statusAfter: statusResult.statusAfter,
      },
      'Status is active with successful requests but IP did not change - marking as FAILED (IP change is required for success)'
    );
  }

  return {
    success,
    ipAfter: ipResult.ipAfter,
    statusAfter: statusResult.statusAfter,
    wsStatusAfter: statusResult.wsStatusAfter,
    method,
  };
}

/**
 * Verify a single rotation with adaptive retry logic
 * 
 * @param rotationId - Rotation record ID
 * @param attempt - Current attempt number (0-indexed)
 * @param cycleType - Type of rotation cycle ('periodic', 'inactive_proxy', 'manual')
 * @param makeRequest - Whether to make a new proxy request for verification (default: true for periodic cycles)
 * @returns Verification result
 */
export async function verifyRotationAdaptive(
  rotationId: string,
  attempt: number = 0,
  cycleType?: string,
  makeRequest: boolean = false
): Promise<{
  success: boolean;
  verified: boolean;
}> {
  // Read current rotation state - this ensures we have the latest retryCount from database
  // Important for parallel processing to avoid race conditions
  const rotation = await prisma.ipRotation.findUnique({
    where: { id: rotationId },
    select: {
      proxyId: true,
      commandSentAt: true,
      retryCount: true,
      success: true,
      verifiedAt: true,
    },
  });

  if (!rotation) {
    return { success: false, verified: false };
  }

  // If already verified (has verifiedAt timestamp), return current status
  if (rotation.verifiedAt !== null) {
    return { success: rotation.success, verified: true };
  }

  const waitTimeMs = config.rotationTracking.verificationWaitTimeMs; // Fixed wait time between iterations (15 seconds)
  const maxAttempts = config.rotationTracking.maxVerificationAttempts; // Max 5 iterations
  const timeoutMs = config.rotationTracking.verificationTimeoutMs; // Default timeout

  // Calculate current retry count based on attempt number
  // IMPORTANT: Always use attempt + 1 to ensure correct iteration tracking
  // Don't use DB value as it might be stale - each attempt should have its own retryCount
  // attempt 0 = retryCount 1, attempt 1 = retryCount 2, etc.
  const currentRetryCount = attempt + 1;
  
  // Calculate elapsed time BEFORE verification to check if we should even start
  const elapsedMsBeforeVerification = Date.now() - rotation.commandSentAt.getTime();
  
  // If we've already exceeded timeout before starting this attempt, mark as timeout
  if (elapsedMsBeforeVerification > timeoutMs && attempt > 0) {
    logger.warn(
      {
        rotationId,
        attempt: currentRetryCount,
        elapsedMs: elapsedMsBeforeVerification,
        timeoutMs,
      },
      'Timeout exceeded before verification attempt - marking as timeout'
    );
    
    // Mark as verified with timeout
    await prisma.ipRotation.update({
      where: { id: rotationId },
      data: {
        retryCount: currentRetryCount,
        waitTimeMs: attempt > 0 ? waitTimeMs : 0,
        verifiedAt: new Date(),
        success: false,
        errorMessage: `Verification timeout before attempt ${currentRetryCount} (elapsed: ${elapsedMsBeforeVerification}ms, timeout: ${timeoutMs}ms)`,
        rotationDurationMs: elapsedMsBeforeVerification,
      },
    });
    
    return { success: false, verified: true };
  }

  // Wait for fixed time (15 seconds) between iterations
  // If this is not the first attempt, wait the fixed interval
  // Each rotation waits independently based on its own iteration
  if (attempt > 0) {
    logger.debug(
      {
        rotationId,
        attempt: currentRetryCount,
        iteration: attempt + 1,
        waitTimeMs,
      },
      `Waiting ${waitTimeMs}ms (fixed interval) before verification attempt ${currentRetryCount}`
    );
    
    await new Promise((resolve) => setTimeout(resolve, waitTimeMs));
  }

  // Perform verification
  // For periodic cycles, make a proxy request with source='periodic_rotation' on each attempt
  const verificationStartTime = Date.now();
  const shouldMakeRequest = makeRequest && cycleType === 'periodic';
  
  logger.info(
    {
      rotationId,
      attempt: currentRetryCount,
      elapsedMsBeforeVerification,
      timeoutMs,
      willExceedTimeout: elapsedMsBeforeVerification > timeoutMs,
    },
    `Starting verification attempt ${currentRetryCount}`
  );
  
  const result = await verifyRotationByBoth(rotationId, cycleType, shouldMakeRequest);
  
  const verificationDurationMs = Date.now() - verificationStartTime;
  
  // Calculate elapsed time from command sent - this is per-rotation, independent of other rotations
  const elapsedMsAfterVerification = Date.now() - rotation.commandSentAt.getTime();
  
  logger.info(
    {
      rotationId,
      attempt: currentRetryCount,
      verificationDurationMs,
      elapsedMsAfterVerification,
      resultSuccess: result.success,
    },
    `Completed verification attempt ${currentRetryCount} (took ${verificationDurationMs}ms, total elapsed: ${elapsedMsAfterVerification}ms)`
  );
  
  // Calculate wait time for this iteration
  // For attempt 0: no wait (0ms)
  // For attempt 1+: fixed wait time (15 seconds)
  const actualWaitTimeMs = attempt > 0 ? waitTimeMs : 0;

  // ALWAYS store status values - this is a log table, we want to record device state
  // regardless of whether verification succeeded or not
  // The success field indicates if rotation worked, but we still log the actual status values
  // Use atomic increment to handle parallel processing correctly
  const updateData: any = {
    retryCount: currentRetryCount, // Update verify count after each attempt - tracks iteration number
    waitTimeMs: actualWaitTimeMs, // Store the actual wait time for this iteration (0 for first, 15s for others)
  };

  // Store status values if we have them (even if verification failed)
  // Use nullish coalescing to preserve null values (don't convert to undefined)
  if (result.ipAfter !== undefined) {
    updateData.ipAfter = result.ipAfter ?? null;
  }
  if (result.statusAfter !== undefined) {
    updateData.statusAfter = result.statusAfter ?? null;
  }
  if (result.wsStatusAfter !== undefined) {
    updateData.wsStatusAfter = result.wsStatusAfter ?? null;
  }

  if (result.success) {
    // Success - IP changed and/or status is active
    // IMPORTANT: Stop immediately - no need to continue retrying if verification succeeded
    // Mark as verified and store all values
    updateData.success = true;
    updateData.verificationMethod = result.method;
    updateData.verifiedAt = new Date();
    updateData.rotationDurationMs = elapsedMsAfterVerification; // Total elapsed time from command sent
    updateData.errorMessage = null;
    
    // Log if verification took unusually long
    if (elapsedMsAfterVerification > waitTimeMs * 2) {
      logger.warn(
        {
          rotationId,
          elapsedMs: elapsedMsAfterVerification,
          waitTimeMs,
          retryCount: currentRetryCount,
        },
        `Verification succeeded but took ${elapsedMsAfterVerification}ms (expected < ${waitTimeMs * 2}ms)`
      );
    }

    await prisma.ipRotation.update({
      where: { id: rotationId },
      data: updateData,
    });

    // Update device details AFTER ip_rotations log is created
    // This ensures status_before/status_after capture the correct values
    if (rotation.proxyId && (result.statusAfter !== null || result.wsStatusAfter !== null)) {
      await updateDeviceDetailsAfterRotation(
        rotation.proxyId,
        result.statusAfter,
        result.wsStatusAfter,
        rotationId
      );
    }

    logger.info(
      {
        rotationId,
        iteration: currentRetryCount,
        attempt: attempt + 1,
        method: result.method,
        ipAfter: result.ipAfter,
        statusAfter: result.statusAfter,
        wsStatusAfter: result.wsStatusAfter,
        elapsedMs: elapsedMsAfterVerification,
        retryCount: currentRetryCount, // Verification count (iteration number)
        waitTimeMs: actualWaitTimeMs, // Actual wait time for this iteration
      },
      `Rotation verified successfully after ${currentRetryCount} iteration(s) - stopping retries (success=true)`
    );

    // Stop immediately - no need to retry if verification succeeded
    return { success: true, verified: true };
  }

  // Not successful yet - verification failed (IP not changed or status not active)
  // Store current status values and continue retrying if we haven't hit limits
  // This is a log table, so we want to record the device state at each attempt
  await prisma.ipRotation.update({
    where: { id: rotationId },
    data: updateData,
  });

  // Update device details AFTER ip_rotations log is created
  // This ensures status_before/status_after capture the correct values
  if (rotation.proxyId && (result.statusAfter !== null || result.wsStatusAfter !== null)) {
    await updateDeviceDetailsAfterRotation(
      rotation.proxyId,
      result.statusAfter,
      result.wsStatusAfter,
      rotationId
    );
  }

  logger.info(
    {
      rotationId,
      iteration: currentRetryCount,
      attempt: attempt + 1,
      retryCount: currentRetryCount,
      ipAfter: result.ipAfter,
      statusAfter: result.statusAfter,
      wsStatusAfter: result.wsStatusAfter,
      elapsedMs: elapsedMsAfterVerification,
      waitTimeMs: actualWaitTimeMs, // Actual wait time for this iteration
    },
    `Status values stored for iteration ${currentRetryCount} (verification not yet successful)`
  );

  // Check if we should retry or if we've hit limits
  // nextAttempt is the next attempt number (0-indexed)
  // nextRetryCount is the retryCount for the next attempt (1-indexed, so nextAttempt + 1)
  const nextAttempt = attempt + 1;
  const nextRetryCount = nextAttempt + 1; // retryCount = attempt + 1
  const willExceedMaxAttempts = nextRetryCount > maxAttempts;
  const willExceedTimeout = elapsedMsAfterVerification >= timeoutMs;
  
  // Retry if we haven't exceeded limits
  // Each rotation tracks its own iteration independently
  if (!willExceedMaxAttempts && !willExceedTimeout) {
    logger.info(
      {
        rotationId,
        currentRetryCount,
        nextRetryCount,
        maxAttempts,
        elapsedMs: elapsedMsAfterVerification,
        timeoutMs,
        willExceedMaxAttempts,
        willExceedTimeout,
      },
      `Continuing to next verification attempt (${nextRetryCount}/${maxAttempts})`
    );
    // Continue to next attempt - retryCount already updated above
    return verifyRotationAdaptive(rotationId, nextAttempt, cycleType, makeRequest);
  }

  // Final failure - we've hit max attempts or timeout
  // Mark as verified with final status
  const finalElapsedMs = elapsedMsAfterVerification;
  
  // Determine error message
  let errorMessage = null;
  if (!result.success) {
    if (willExceedMaxAttempts) {
      errorMessage = `Verification failed after ${currentRetryCount} attempts (max: ${maxAttempts})`;
    } else if (willExceedTimeout) {
      errorMessage = `Verification timeout after ${finalElapsedMs}ms (timeout: ${timeoutMs}ms)`;
    }
  }
  
  // Update with final status
  // Ensure retryCount and waitTimeMs are always set correctly for final update
  updateData.success = result.success;
  updateData.verificationMethod = result.method;
  updateData.verifiedAt = new Date();
  updateData.rotationDurationMs = finalElapsedMs; // Total elapsed time from command sent
  updateData.errorMessage = errorMessage;
  // retryCount and waitTimeMs already set above - ensure they're correct
  // retryCount = currentRetryCount (current iteration number, 1-based)
  // waitTimeMs = actualWaitTimeMs (wait time before this attempt)
  
  await prisma.ipRotation.update({
    where: { id: rotationId },
    data: updateData,
  });

  // Update device details AFTER ip_rotations log is created
  // This ensures status_before/status_after capture the correct values
  if (rotation.proxyId && (result.statusAfter !== null || result.wsStatusAfter !== null)) {
    await updateDeviceDetailsAfterRotation(
      rotation.proxyId,
      result.statusAfter,
      result.wsStatusAfter,
      rotationId
    );
  }

  logger.info(
    {
      rotationId,
      iteration: currentRetryCount,
      attempt: attempt + 1,
      maxAttempts,
      timeoutMs,
      finalElapsedMs,
      willExceedMaxAttempts,
      willExceedTimeout,
      resultSuccess: result.success,
      resultIpAfter: result.ipAfter,
      resultStatusAfter: result.statusAfter,
      resultWsStatusAfter: result.wsStatusAfter,
      resultMethod: result.method,
      retryCount: currentRetryCount, // Final verification count (total iterations)
      waitTimeMs: actualWaitTimeMs, // Wait time for this iteration
    },
    `Final verification completed after ${currentRetryCount} iteration(s) - max iterations (${maxAttempts}) or timeout (${timeoutMs}ms) reached, verification count updated`
  );

  return { success: result.success, verified: true };
}

/**
 * Verify all rotations in a cycle
 * 
 * This function verifies ALL proxies in the rotation cycle, including both active and inactive proxies.
 * For periodic cycles, it makes proxy requests with source='periodic_rotation' to check the status
 * of all proxies (active and inactive).
 * 
 * @param cycleId - Cycle ID
 */
export async function verifyRotationCycle(cycleId: string): Promise<void> {
  // Get cycle type to determine if we should make proxy requests with source='periodic_rotation'
  const cycle = await prisma.rotationCycle.findUnique({
    where: { id: cycleId },
    select: {
      cycleType: true,
      totalProxies: true,
    },
  });

  const cycleType = cycle?.cycleType || null;
  // For periodic cycles, make proxy requests with source='periodic_rotation' during verification
  const makeRequest = cycleType === 'periodic';

  // Get all rotations for this cycle that haven't been verified yet
  const allRotations = await prisma.ipRotation.findMany({
    where: {
      cycleId,
      verifiedAt: null, // Only verify rotations that haven't been verified yet
    },
    select: {
      id: true,
      proxyId: true,
      commandResponse: true,
      errorMessage: true,
    },
  });

  // Filter out rotations with null or invalid command responses
  // If commandResponse is null or response.success is false, skip verification and mark as failed
  const rotationsToVerify: typeof allRotations = [];
  const rotationsToSkip: typeof allRotations = [];

  for (const rotation of allRotations) {
    // Check if command response is null or invalid
    if (!rotation.commandResponse) {
      // Command response is null - mark as failed immediately without verification
      rotationsToSkip.push(rotation);
      continue;
    }

    // Parse command response to check if it's valid
    try {
      const commandResponse = typeof rotation.commandResponse === 'string' 
        ? JSON.parse(rotation.commandResponse) 
        : rotation.commandResponse;
      
      // If response doesn't have success=true, skip verification
      if (!commandResponse || commandResponse.success !== true) {
        rotationsToSkip.push(rotation);
        continue;
      }

      // Valid response - include in verification
      rotationsToVerify.push(rotation);
    } catch (error) {
      // Invalid JSON or response - skip verification
      rotationsToSkip.push(rotation);
    }
  }

  // Mark skipped rotations as failed immediately
  if (rotationsToSkip.length > 0) {
    logger.info(
      {
        cycleId,
        skippedCount: rotationsToSkip.length,
        skippedProxyIds: rotationsToSkip.map((r) => r.proxyId),
      },
      'Skipping verification for rotations with null or invalid command responses'
    );

    // Update all skipped rotations as failed
    await Promise.all(
      rotationsToSkip.map((rotation) =>
        prisma.ipRotation.update({
          where: { id: rotation.id },
          data: {
            success: false,
            verifiedAt: new Date(),
            retryCount: 0, // No verification attempts made
            waitTimeMs: 0, // No wait time
            errorMessage: rotation.errorMessage || 'Rotation command failed - no valid response received',
            verificationMethod: 'none',
            rotationDurationMs: 0,
          },
        })
      )
    );
  }

  // Use only rotations with valid command responses for verification
  const rotations = rotationsToVerify;

  // Get proxy status information for logging (only for rotations that will be verified)
  const proxyStatusCounts = await Promise.all(
    rotations.map(async (rotation) => {
      try {
        const proxy = await prisma.proxy.findUnique({
          where: { deviceId: rotation.proxyId },
          select: { active: true },
        });
        return proxy?.active ?? null;
      } catch {
        return null;
      }
    })
  );

  const activeCount = proxyStatusCounts.filter((active) => active === true).length;
  const inactiveCount = proxyStatusCounts.filter((active) => active === false).length;
  const unknownCount = proxyStatusCounts.filter((active) => active === null).length;

  logger.info(
    {
      cycleId,
      cycleType,
      totalProxies: cycle?.totalProxies || allRotations.length,
      totalRotations: allRotations.length,
      rotationsToVerify: rotations.length,
      rotationsSkipped: rotationsToSkip.length,
      activeProxies: activeCount,
      inactiveProxies: inactiveCount,
      unknownStatus: unknownCount,
      makeRequest,
    },
    `Starting verification for rotation cycle - ${rotations.length} rotations to verify, ${rotationsToSkip.length} skipped (null/invalid command response)`
  );

  // Verify all rotations in parallel - this includes both active and inactive proxies
  const verificationPromises = rotations.map((rotation) =>
    verifyRotationAdaptive(rotation.id, 0, cycleType || undefined, makeRequest)
  );

  const results = await Promise.allSettled(verificationPromises);
  
  const successful = results.filter((r) => r.status === 'fulfilled' && r.value.success).length;
  const failed = results.filter((r) => r.status === 'fulfilled' && !r.value.success).length;
  const errors = results.filter((r) => r.status === 'rejected').length;

  logger.info(
    {
      cycleId,
      cycleType,
      totalRotations: allRotations.length,
      rotationsVerified: rotations.length,
      rotationsSkipped: rotationsToSkip.length,
      activeProxies: activeCount,
      inactiveProxies: inactiveCount,
      successful,
      failed,
      errors,
      makeRequest,
    },
    `Rotation cycle verification completed - ${rotations.length} verified (${successful} successful, ${failed} failed), ${rotationsToSkip.length} skipped due to invalid command response`
  );
}

