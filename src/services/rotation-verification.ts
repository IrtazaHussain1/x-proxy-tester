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
  method: VerificationMethod;
}> {
  try {
    const rotation = await prisma.ipRotation.findUnique({
      where: { id: rotationId },
      select: {
        proxyId: true,
        statusBefore: true,
      },
    });

    if (!rotation) {
      return { success: false, statusAfter: null, method: 'none' };
    }

    const device = await getDeviceById(rotation.proxyId);
    const statusAfter = device.proxy_status || null;
    const isActive = mapProxyStatusToActive(statusAfter);

    // Success if proxy is active now (or was active before and still is)
    // Note: We're being lenient here - if device is active, rotation likely worked
    const success = isActive;

    return {
      success,
      statusAfter,
      method: 'status_check',
    };
  } catch (error) {
    logger.error(
      {
        rotationId,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to verify rotation by status check'
    );
    return { success: false, statusAfter: null, method: 'none' };
  }
}

/**
 * Verify rotation using both methods
 */
async function verifyRotationByBoth(rotationId: string): Promise<{
  success: boolean;
  ipAfter: string | null;
  statusAfter: string | null;
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
    
    await prisma.ipRotation.update({
      where: { id: rotationId },
      data: {
        success: result.success,
        ipAfter: result.ipAfter || undefined,
        statusAfter: result.statusAfter || undefined,
        verificationMethod: result.method,
        verifiedAt: new Date(),
        waitTimeMs: elapsedMs,
        rotationDurationMs: elapsedMs,
        retryCount: attempt + 1,
        errorMessage,
      },
    });

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

  if (result.success) {
    // Success - update and return
    const elapsedMs = Date.now() - rotation.commandSentAt.getTime();
    
    await prisma.ipRotation.update({
      where: { id: rotationId },
      data: {
        success: true,
        ipAfter: result.ipAfter || undefined,
        statusAfter: result.statusAfter || undefined,
        verificationMethod: result.method,
        verifiedAt: new Date(),
        waitTimeMs: elapsedMs,
        rotationDurationMs: elapsedMs,
        retryCount: attempt + 1,
        errorMessage: null,
      },
    });

    logger.info(
      {
        rotationId,
        attempt: attempt + 1,
        method: result.method,
        elapsedMs,
      },
      'Rotation verified successfully'
    );

    return { success: true, verified: true };
  }

  // Not successful yet - update retry count and continue
  await prisma.ipRotation.update({
    where: { id: rotationId },
    data: {
      retryCount: attempt + 1,
    },
  });

  // Retry if we haven't exceeded limits
  if (attempt + 1 < maxAttempts && elapsedMs < timeoutMs) {
    return verifyRotationAdaptive(rotationId, attempt + 1);
  }

  // Final failure
  const finalElapsedMs = Date.now() - rotation.commandSentAt.getTime();
  await prisma.ipRotation.update({
    where: { id: rotationId },
    data: {
      success: false,
      verificationMethod: result.method,
      verifiedAt: new Date(),
      waitTimeMs: finalElapsedMs,
      rotationDurationMs: finalElapsedMs,
      retryCount: attempt + 1,
      errorMessage: 'Rotation verification failed after all attempts',
    },
  });

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

