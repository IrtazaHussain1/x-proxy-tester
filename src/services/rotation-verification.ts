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

export type VerificationMethod = 'ip_comparison' | 'status_check' | 'both' | 'none';

/**
 * Verify rotation by comparing IP from test requests
 * Checks if IP changed in proxy_requests after rotation command
 */
async function verifyRotationByIpComparison(rotationId: string): Promise<{
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

    // If ipAfter is already populated (by continuous tester), trust it
    if (rotation.ipAfter && rotation.ipBefore && rotation.ipAfter !== rotation.ipBefore) {
      return { success: true, ipAfter: rotation.ipAfter, method: 'ip_comparison' };
    }

    // Find proxy requests after rotation command
    const requests = await prisma.proxyRequest.findMany({
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
      take: 10, // Check last 10 requests
      select: {
        outboundIp: true,
        timestamp: true,
      },
    });

    if (requests.length === 0) {
      return { success: false, ipAfter: null, method: 'ip_comparison' };
    }

    // Check if IP changed
    const latestIp = requests[0].outboundIp;
    const ipChanged = rotation.ipBefore !== null && latestIp !== rotation.ipBefore;

    if (ipChanged && latestIp) {
      return { success: true, ipAfter: latestIp, method: 'ip_comparison' };
    }

    // If IP is same but we have a new IP (first time seeing this IP), consider it success
    if (latestIp && !rotation.ipBefore) {
      return { success: true, ipAfter: latestIp, method: 'ip_comparison' };
    }

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

    logger.debug(
      {
        rotationId,
        proxyId: rotation.proxyId,
        statusBefore: rotation.statusBefore,
        statusAfter,
        wsStatusAfter,
        isActive,
        deviceProxyStatus: device.proxy_status,
        deviceWsStatus: device.ws_status,
        deviceHasProxyStatus: 'proxy_status' in device,
        deviceHasWsStatus: 'ws_status' in device,
      },
      'Status check result - values captured even if verification fails'
    );

    // Success if proxy is active now (or was active before and still is)
    // Note: We're being lenient here - if device is active, rotation likely worked
    // BUT: We still return statusAfter/wsStatusAfter even if success = false
    const success = isActive;

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
 */
async function verifyRotationByBoth(rotationId: string): Promise<{
  success: boolean;
  ipAfter: string | null;
  statusAfter: string | null;
  wsStatusAfter: string | null;
  method: VerificationMethod;
}> {
  const [ipResult, statusResult] = await Promise.all([
    verifyRotationByIpComparison(rotationId),
    verifyRotationByStatusCheck(rotationId),
  ]);

  // Success if either method confirms success
  const success = ipResult.success || statusResult.success;
  const method: VerificationMethod = success
    ? ipResult.success && statusResult.success
      ? 'both'
      : ipResult.success
        ? 'ip_comparison'
        : 'status_check'
    : 'both';

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
 * @returns Verification result
 */
export async function verifyRotationAdaptive(
  rotationId: string,
  attempt: number = 0
): Promise<{
  success: boolean;
  verified: boolean;
}> {
  const rotation = await prisma.ipRotation.findUnique({
    where: { id: rotationId },
    select: {
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

  const waitTimes = config.rotationTracking.verificationWaitTimes;
  const maxAttempts = config.rotationTracking.maxVerificationAttempts;
  const timeoutMs = config.rotationTracking.verificationTimeoutMs;

  // Check if we've exceeded max attempts (but allow at least one try)
  // Or if timeout exceeded AND we've already tried at least once
  const elapsedMs = Date.now() - rotation.commandSentAt.getTime();
  if (attempt >= maxAttempts || (attempt > 0 && elapsedMs > timeoutMs)) {
    // Final attempt - verify one last time
    const result = await verifyRotationByBoth(rotationId);
    
    // Determine appropriate error message
    let errorMessage = null;
    if (!result.success) {
      if (attempt >= maxAttempts) {
        errorMessage = `Verification failed after ${attempt + 1} attempts`;
      } else {
        errorMessage = `Verification timeout after ${elapsedMs}ms`;
      }
    }
    
    logger.debug(
      {
        rotationId,
        attempt: attempt + 1,
        resultSuccess: result.success,
        resultIpAfter: result.ipAfter,
        resultStatusAfter: result.statusAfter,
        resultWsStatusAfter: result.wsStatusAfter,
        resultMethod: result.method,
        elapsedMs,
      },
      'Final verification attempt result'
    );
    
    await prisma.ipRotation.update({
      where: { id: rotationId },
      data: {
        success: result.success,
        ipAfter: result.ipAfter ?? null,  // Use nullish coalescing to preserve null
        statusAfter: result.statusAfter ?? null,  // Use nullish coalescing to preserve null
        wsStatusAfter: result.wsStatusAfter ?? null,  // Use nullish coalescing to preserve null
        verificationMethod: result.method,
        verifiedAt: new Date(),
        waitTimeMs: elapsedMs,
        rotationDurationMs: elapsedMs,
        retryCount: attempt + 1,
        errorMessage,
      },
    });

    logger.info(
      {
        rotationId,
        success: result.success,
        ipAfter: result.ipAfter,
        statusAfter: result.statusAfter,
        wsStatusAfter: result.wsStatusAfter,
        method: result.method,
        elapsedMs,
      },
      'Final verification completed'
    );

    return { success: result.success, verified: true };
  }

  // Wait for the appropriate time based on attempt
  const waitTime = waitTimes[Math.min(attempt, waitTimes.length - 1)] || waitTimes[waitTimes.length - 1];
  
  // If this is not the first attempt, wait
  if (attempt > 0) {
    const timeSinceCommand = Date.now() - rotation.commandSentAt.getTime();
    const waitRemaining = Math.max(0, waitTime - timeSinceCommand);
    
    if (waitRemaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitRemaining));
    }
  }

  // Perform verification
  const result = await verifyRotationByBoth(rotationId);
  const elapsedMsAfterVerification = Date.now() - rotation.commandSentAt.getTime();

  // ALWAYS store status values - this is a log table, we want to record device state
  // regardless of whether verification succeeded or not
  // The success field indicates if rotation worked, but we still log the actual status values
  const updateData: any = {
    retryCount: attempt + 1,
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
    // Success - mark as verified and store all values
    updateData.success = true;
    updateData.verificationMethod = result.method;
    updateData.verifiedAt = new Date();
    updateData.waitTimeMs = elapsedMsAfterVerification;
    updateData.rotationDurationMs = elapsedMsAfterVerification;
    updateData.errorMessage = null;

    await prisma.ipRotation.update({
      where: { id: rotationId },
      data: updateData,
    });

    logger.info(
      {
        rotationId,
        attempt: attempt + 1,
        method: result.method,
        ipAfter: result.ipAfter,
        statusAfter: result.statusAfter,
        wsStatusAfter: result.wsStatusAfter,
        elapsedMs: elapsedMsAfterVerification,
      },
      'Rotation verified successfully - status values stored'
    );

    return { success: true, verified: true };
  }

  // Not successful yet - but STILL store current status values (this is a log table!)
  // We want to record the device state at each attempt, even if verification hasn't succeeded
  await prisma.ipRotation.update({
    where: { id: rotationId },
    data: updateData,
  });

  logger.debug(
    {
      rotationId,
      attempt: attempt + 1,
      ipAfter: result.ipAfter,
      statusAfter: result.statusAfter,
      wsStatusAfter: result.wsStatusAfter,
      elapsedMs: elapsedMsAfterVerification,
    },
    'Status values stored for retry attempt (verification not yet successful)'
  );

  // Retry if we haven't exceeded limits
  if (attempt + 1 < maxAttempts && elapsedMsAfterVerification < timeoutMs) {
    return verifyRotationAdaptive(rotationId, attempt + 1);
  }

  // Final failure - IMPORTANT: Get fresh result and include statusAfter
  const finalElapsedMs = Date.now() - rotation.commandSentAt.getTime();
  const finalResult = await verifyRotationByBoth(rotationId); // Get fresh result for final failure
  debugger;
  logger.debug(
    {
      rotationId,
      finalResultSuccess: finalResult.success,
      finalResultIpAfter: finalResult.ipAfter,
      finalResultStatusAfter: finalResult.statusAfter,
      finalResultWsStatusAfter: finalResult.wsStatusAfter,
      finalResultMethod: finalResult.method,
      finalElapsedMs,
    },
    'Final failure verification result'
  );
  
  await prisma.ipRotation.update({
    where: { id: rotationId },
    data: {
      success: false,
      ipAfter: finalResult.ipAfter ?? null,  // Use nullish coalescing to preserve null
      statusAfter: finalResult.statusAfter ?? null,  // Use nullish coalescing to preserve null
      wsStatusAfter: finalResult.wsStatusAfter ?? null,  // Use nullish coalescing to preserve null
      verificationMethod: finalResult.method,
      verifiedAt: new Date(),
      waitTimeMs: finalElapsedMs,
      rotationDurationMs: finalElapsedMs,
      retryCount: attempt + 1,
      errorMessage: 'Rotation verification failed after all attempts',
    },
  });

  logger.info(
    {
      rotationId,
      success: false,
      ipAfter: finalResult.ipAfter,
      statusAfter: finalResult.statusAfter,
      wsStatusAfter: finalResult.wsStatusAfter,
      method: finalResult.method,
      finalElapsedMs,
    },
    'Rotation verification failed - final status stored'
  );

  return { success: false, verified: true };
}

/**
 * Verify all rotations in a cycle
 * 
 * @param cycleId - Cycle ID
 */
export async function verifyRotationCycle(cycleId: string): Promise<void> {
  const rotations = await prisma.ipRotation.findMany({
    where: {
      cycleId,
      verifiedAt: null, // Only verify rotations that haven't been verified yet
    },
    select: {
      id: true,
    },
  });

  logger.info(
    {
      cycleId,
      rotationCount: rotations.length,
    },
    'Starting verification for rotation cycle'
  );

  // Verify all rotations in parallel
  const verificationPromises = rotations.map((rotation) =>
    verifyRotationAdaptive(rotation.id, 0)
  );

  await Promise.allSettled(verificationPromises);

  logger.info({ cycleId }, 'Rotation cycle verification completed');
}

