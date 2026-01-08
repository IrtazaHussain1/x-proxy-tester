/**
 * Rotation Cycle Manager
 * 
 * Manages rotation cycles with shared timestamps for aggregation.
 * Handles cycle creation, command sending, and verification orchestration.
 * 
 * @module services/rotation-cycle-manager
 */

import { prismaWithRetry as prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { rotateIp, rotateUniqueIp } from '../api/commands';
import { getAllDevices } from '../helpers/devices';
import { getDeviceById } from '../api/devices';
export type CycleType = 'periodic' | 'inactive_proxy' | 'manual';
export type CycleStatus = 'in_progress' | 'verifying' | 'completed' | 'failed';

/**
 * Create a new rotation cycle with shared timestamp
 * 
 * @param cycleType - Type of rotation cycle
 * @param proxyIds - Array of proxy IDs to rotate in this cycle
 * @returns Created cycle ID
 */
export async function createRotationCycle(
  cycleType: CycleType,
  proxyIds: string[]
): Promise<string> {
  const cycleTimestamp = new Date(); // Shared timestamp for all rotations in cycle
  
  const cycle = await prisma.rotationCycle.create({
    data: {
      cycleType,
      cycleTimestamp,
      totalProxies: proxyIds.length,
      successfulCount: 0,
      failedCount: 0,
      pendingCount: proxyIds.length,
      status: 'in_progress',
    },
  });

  logger.info(
    {
      cycleId: cycle.id,
      cycleType,
      totalProxies: proxyIds.length,
      cycleTimestamp: cycleTimestamp.toISOString(),
    },
    'Created rotation cycle'
  );

  return cycle.id;
}

/**
 * Get IP before rotation from proxy record
 */
async function getIpBeforeRotation(proxyId: string): Promise<string | null> {
  try {
    const proxy = await prisma.proxy.findUnique({
      where: { deviceId: proxyId },
      select: { lastIp: true },
    });
    return proxy?.lastIp || null;
  } catch (error) {
    logger.error({ proxyId, error }, 'Failed to get IP before rotation');
    return null;
  }
}

/**
 * Get device metadata for storage
 */
async function getDeviceMetadata(deviceId: string): Promise<Record<string, any> | null> {
  try {
    const device = await getDeviceById(deviceId);
    return {
      name: device.name,
      country: device.country || null,
      state: device.state || null,
      city: device.city || null,
    };
  } catch (error) {
    logger.error({ deviceId, error }, 'Failed to get device metadata');
    return null;
  }
}

/**
 * Send rotation command to a single proxy and create rotation record
 */
async function sendRotationCommandForProxy(
  cycleId: string,
  cycleTimestamp: Date,
  proxyId: string,
  rotationType: 'standard' | 'unique',
  statusBefore: string | null
): Promise<string> {
  const commandSentAt = new Date();
  const ipBefore = await getIpBeforeRotation(proxyId);
  const deviceMetadata = await getDeviceMetadata(proxyId);

  let commandResponse: any = null;
  let errorMessage: string | null = null;

  try {
    const response = rotationType === 'unique'
      ? await rotateUniqueIp(proxyId)
      : await rotateIp(proxyId);
    
    commandResponse = response;
    
    if (!response.success) {
      errorMessage = response.message || 'Rotation command failed';
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ proxyId, error }, 'Failed to send rotation command');
  }

  const rotation = await prisma.ipRotation.create({
    data: {
      cycleId,
      proxyId,
      rotationTimestamp: cycleTimestamp,
      rotationType,
      commandSentAt,
      commandResponse: commandResponse ? JSON.parse(JSON.stringify(commandResponse)) : null,
      ipBefore,
      statusBefore: statusBefore || null,
      success: false, // Will be updated during verification
      deviceMetadata: deviceMetadata ? JSON.parse(JSON.stringify(deviceMetadata)) : null,
      retryCount: 0,
      errorMessage,
    },
  });

  return rotation.id;
}

/**
 * Start rotation cycle - send commands to all proxies
 * 
 * @param cycleId - Cycle ID
 * @param proxyIds - Array of proxy IDs
 * @param rotationType - Type of rotation (standard or unique)
 */
export async function startRotationCycle(
  cycleId: string,
  proxyIds: string[],
  rotationType: 'standard' | 'unique' = 'standard'
): Promise<void> {
  const cycle = await prisma.rotationCycle.findUnique({
    where: { id: cycleId },
  });

  if (!cycle) {
    throw new Error(`Rotation cycle ${cycleId} not found`);
  }

  logger.info(
    {
      cycleId,
      proxyCount: proxyIds.length,
      rotationType,
    },
    'Starting rotation cycle - sending commands'
  );

  // Get all devices to get status before rotation
  const devices = await getAllDevices();
  const deviceMap = new Map(devices.map((d) => [d.device_id, d]));

  // Send rotation commands in parallel
  const rotationPromises = proxyIds.map(async (proxyId) => {
    const device = deviceMap.get(proxyId);
    const statusBefore = device?.proxy_status || null;
    
    try {
      await sendRotationCommandForProxy(
        cycleId,
        cycle.cycleTimestamp,
        proxyId,
        rotationType,
        statusBefore
      );
    } catch (error) {
      logger.error(
        {
          cycleId,
          proxyId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to create rotation record'
      );
    }
  });

  await Promise.allSettled(rotationPromises);

  // Update cycle status to verifying
  await prisma.rotationCycle.update({
    where: { id: cycleId },
    data: {
      status: 'verifying',
    },
  });

  logger.info({ cycleId }, 'Rotation cycle commands sent, starting verification');
}

/**
 * Complete rotation cycle - update final aggregates
 * 
 * @param cycleId - Cycle ID
 */
export async function completeRotationCycle(cycleId: string): Promise<void> {
  const rotations = await prisma.ipRotation.findMany({
    where: { cycleId },
    select: {
      success: true,
    },
  });

  const successfulCount = rotations.filter((r) => r.success).length;
  const failedCount = rotations.filter((r) => !r.success).length;
  const pendingCount = rotations.length - successfulCount - failedCount;

  await prisma.rotationCycle.update({
    where: { id: cycleId },
    data: {
      successfulCount,
      failedCount,
      pendingCount,
      status: pendingCount > 0 ? 'verifying' : 'completed',
    },
  });

  logger.info(
    {
      cycleId,
      successfulCount,
      failedCount,
      pendingCount,
    },
    'Rotation cycle completed'
  );
}

/**
 * Get rotation cycle by ID
 */
export async function getRotationCycle(cycleId: string) {
  return prisma.rotationCycle.findUnique({
    where: { id: cycleId },
    include: {
      rotations: {
        orderBy: { rotationTimestamp: 'desc' },
      },
    },
  });
}

