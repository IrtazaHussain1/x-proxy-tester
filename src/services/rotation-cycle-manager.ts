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
import type { CommandRetryOptions } from '../api/commands';
import { getAllDevices } from '../helpers/devices';
import { getDeviceById } from '../api/devices';
import { config } from '../config';
import type { Device } from '../types';
export type CycleType = 'periodic' | 'inactive_proxy' | 'manual';
export type CycleStatus = 'in_progress' | 'verifying' | 'completed' | 'failed';

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
    logger.error({ proxyId, error: error instanceof Error ? error.message : String(error) }, 'Failed to get IP before rotation');
    return null;
  }
}

/**
 * Build the metadata blob persisted on the IpRotation record from an
 * already-loaded Device. Cheap, synchronous, no I/O — preferred over
 * `getDeviceMetadata` whenever the caller already has the device in hand
 * (e.g. from the cached `getAllDevices()` result).
 */
function buildDeviceMetadataFromDevice(device: Device): Record<string, any> {
  return {
    name: device.name,
    country: device.country || null,
    state: device.state || null,
    city: device.city || null,
  };
}

/**
 * Get device metadata for storage.
 *
 * NOTE: This performs a DB lookup + a portal API call (`getDeviceById`).
 * It is kept as a fallback for paths that don't already have a Device handy.
 * Hot paths (e.g. periodic rotation cycle) should prefer
 * `buildDeviceMetadataFromDevice` to avoid 1 API call per device.
 */
async function getDeviceMetadata(deviceId: string): Promise<Record<string, any> | null> {
  try {
    // Fetch deviceApiId (integer ID) from Proxy table - API expects integer ID, not string device_id
    const proxy = await prisma.proxy.findUnique({
      where: { deviceId },
      select: { deviceApiId: true },
    });

    if (!proxy || !proxy.deviceApiId) {
      logger.warn(
        { deviceId },
        'Proxy not found or deviceApiId missing - cannot fetch device metadata'
      );
      return null;
    }

    // Use deviceApiId (integer) instead of deviceId (string device_id)
    const device = await getDeviceById(proxy.deviceApiId);
    return {
      name: device.name,
      country: device.country || null,
      state: device.state || null,
      city: device.city || null,
    };
  } catch (error) {
    logger.error({ deviceId, error: error instanceof Error ? error.message : String(error) }, 'Failed to get device metadata');
    return null;
  }
}

/**
 * Send rotation command to a single proxy and create rotation record.
 *
 * @param cycleId - Parent cycle id
 * @param cycleTimestamp - Shared cycle timestamp (used for rotationTimestamp)
 * @param proxyId - Device id (string)
 * @param rotationType - 'standard' | 'unique'
 * @param statusBefore - proxy_status snapshot from portal (pre-rotation)
 * @param wsStatusBefore - ws_status snapshot from portal (pre-rotation)
 * @param device - Optional already-loaded Device. When provided, avoids one
 *                 portal API call (`getDeviceById`) per rotation.
 * @param retryOptions - Optional override for command retry/backoff. Used to
 *                       fast-fail rotation commands during periodic cycles
 *                       (those will simply be retried in the next cycle).
 */
async function sendRotationCommandForProxy(
  cycleId: string,
  cycleTimestamp: Date,
  proxyId: string,
  rotationType: 'standard' | 'unique',
  statusBefore: string | null,
  wsStatusBefore: string | null,
  device?: Device,
  retryOptions?: CommandRetryOptions
): Promise<string> {
  const commandSentAt = new Date();
  const ipBefore = await getIpBeforeRotation(proxyId);
  // Prefer the in-memory Device (no I/O) over the API-call-based fallback.
  // This is the hot path for periodic rotation cycles (thousands of devices).
  const deviceMetadata = device
    ? buildDeviceMetadataFromDevice(device)
    : await getDeviceMetadata(proxyId);

  let commandResponse: any = null;
  let errorMessage: string | null = null;

  try {
    const response = rotationType === 'unique'
      ? await rotateUniqueIp(proxyId, retryOptions)
      : await rotateIp(proxyId, retryOptions);
    
    commandResponse = response;
    
    if (!response.success) {
      errorMessage = response.message || 'Rotation command failed';
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      { proxyId, error: errorMessage },
      'Failed to send rotation command'
    );
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
      wsStatusBefore: wsStatusBefore || null,
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
 * @param cycleType - Cycle type. When 'periodic', a fast-fail retry policy is
 *                    applied to the rotateIp/rotateUniqueIp HTTP calls so that
 *                    one slow/failed cycle doesn't bleed into the next interval.
 */
export async function startRotationCycle(
  cycleId: string,
  proxyIds: string[],
  rotationType: 'standard' | 'unique' = 'standard',
  cycleType?: CycleType
): Promise<void> {
  const cycle = await prisma.rotationCycle.findUnique({
    where: { id: cycleId },
  });

  if (!cycle) {
    throw new Error(`Rotation cycle ${cycleId} not found`);
  }

  // For periodic cycles we override the default 3-retry policy with a much
  // tighter one — failed devices are simply retried in the next periodic
  // tick, so multiplying every failure by 3 retries × backoff is wasteful
  // and was the dominant contributor to >20-min cycle durations.
  const commandRetryOptions: CommandRetryOptions | undefined =
    cycleType === 'periodic'
      ? { maxRetries: config.ipRotation.periodicCommandMaxRetries }
      : undefined;

  logger.info(
    {
      cycleId,
      proxyCount: proxyIds.length,
      rotationType,
      cycleType: cycleType || 'unknown',
      commandConcurrency: config.ipRotation.commandConcurrency,
      commandMaxRetries: commandRetryOptions?.maxRetries ?? 'default',
    },
    'Starting rotation cycle - sending commands'
  );

  // Get all devices to get status before rotation
  const devices = await getAllDevices();
  const deviceMap = new Map(devices.map((d) => [d.device_id, d]));

  // Command sending is API-bound, not Prisma-pool-bound — use a dedicated,
  // higher concurrency semaphore independent of `proxySyncConcurrency`.
  const semaphore = new Semaphore(config.ipRotation.commandConcurrency);
  const rotationPromises = proxyIds.map(async (proxyId) => {
    await semaphore.acquire();
    const device = deviceMap.get(proxyId);
    const statusBefore = device?.proxy_status || null;
    const wsStatusBefore = device?.ws_status || null;
    
    try {
      await sendRotationCommandForProxy(
        cycleId,
        cycle.cycleTimestamp,
        proxyId,
        rotationType,
        statusBefore,
        wsStatusBefore,
        device,
        commandRetryOptions
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
    } finally {
      semaphore.release();
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

