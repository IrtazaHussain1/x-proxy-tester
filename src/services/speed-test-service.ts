/**
 * Speed Test Service
 * 
 * Periodically tests the speed of all active proxies.
 */

import { request, ProxyAgent } from 'undici';
import { prismaWithRetry as prisma, checkDatabaseHealth } from '../lib/db';
import { logger } from '../lib/logger';
import { config } from '../config';
import { getAllDevices } from '../helpers/devices';
import { buildProxyUrl } from '../clients/proxyClient';
import { mapProxyStatusToActive } from './continuous-proxy-tester';
import type { Device } from '../types';

let speedTestTimeout: NodeJS.Timeout | null = null;
const currentlyTestingProxies = new Set<string>();

/**
 * Measures download speed through a proxy
 */
async function measureDownloadSpeed(device: Device): Promise<{ speedMbps: number; success: boolean; latencyMs: number; error?: string }> {
  const proxyUrl = buildProxyUrl(device);
  const agent = new ProxyAgent(proxyUrl);

  const start = Date.now();
  try {
    const response = await request(config.speedTest.targetUrl, {
      dispatcher: agent,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      headersTimeout: config.speedTest.timeoutMs,
      bodyTimeout: config.speedTest.timeoutMs,
    });

    if (response.statusCode >= 400) {
      await response.body.dump();
      return { 
        speedMbps: 0, 
        success: false,
        latencyMs: Date.now() - start, 
        error: `HTTP Error ${response.statusCode}` 
      };
    }

    // Read the stream to measure speed
    let totalBytes = 0;
    for await (const chunk of response.body) {
      totalBytes += chunk.length;
    }

    const durationMs = Date.now() - start;
    const durationSeconds = durationMs / 1000;
    if (durationSeconds <= 0) return { speedMbps: 0, success: false, latencyMs: durationMs, error: 'Duration too short' };
    
    const speedMbps = (totalBytes * 8) / (1024 * 1024) / durationSeconds;

    return { speedMbps, success: true, latencyMs: durationMs };
  } catch (error) {
    return { 
      speedMbps: 0, 
      success: false,
      latencyMs: Date.now() - start, 
      error: error instanceof Error ? error.message : 'Unknown download speed test error' 
    };
  }
}

/**
 * Measures upload speed through a proxy by sending a chunk of data
 */
async function measureUploadSpeed(device: Device): Promise<{ speedMbps: number; success: boolean; latencyMs: number; error?: string }> {
  const proxyUrl = buildProxyUrl(device);
  const agent = new ProxyAgent(proxyUrl);
  
  // Create a 1MB dummy buffer for uploading
  const MB = 1024 * 1024;
  const dummyData = Buffer.alloc(MB, 'x');

  const start = Date.now();
  try {
    const response = await request(config.speedTest.uploadTargetUrl, {
      dispatcher: agent,
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/octet-stream',
      },
      body: dummyData,
      headersTimeout: config.speedTest.timeoutMs,
      bodyTimeout: config.speedTest.timeoutMs,
    });

    await response.body.dump();

    if (response.statusCode >= 400) {
      return { 
        speedMbps: 0, 
        success: false,
        latencyMs: Date.now() - start, 
        error: `HTTP Error ${response.statusCode}` 
      };
    }

    const durationMs = Date.now() - start;
    const durationSeconds = durationMs / 1000;
    if (durationSeconds <= 0) return { speedMbps: 0, success: false, latencyMs: durationMs, error: 'Duration too short' };
    
    const speedMbps = (dummyData.length * 8) / (1024 * 1024) / durationSeconds;

    return { speedMbps, success: true, latencyMs: durationMs };
  } catch (error) {
    return { 
      speedMbps: 0, 
      success: false,
      latencyMs: Date.now() - start, 
      error: error instanceof Error ? error.message : 'Unknown upload speed test error' 
    };
  }
}

/**
 * Runs a speed test for all active proxies
 */
export async function runSpeedTests(): Promise<void> {
  const dbHealth = await checkDatabaseHealth();
  if (!dbHealth.connected) {
    logger.error('Database not connected, skipping speed tests');
    return;
  }

  try {
    // Use a single timestamp for all records in this cycle to simplify aggregation
    const cycleTimestamp = new Date();
    const devices = await getAllDevices();

    // Filter out proxies that are already undergoing a speed test
    const idleDevices = devices.filter((d) => !currentlyTestingProxies.has(d.device_id));

    if (idleDevices.length === 0) {
      return;
    }

    // batch processing to avoid overwhelming system
    const batchSize = config.speedTest.maxConcurrentTests;
    for (let i = 0; i < idleDevices.length; i += batchSize) {
      const batch = idleDevices.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (device) => {
          // Double check in case another cycle started recently
          if (currentlyTestingProxies.has(device.device_id)) return;
          
          currentlyTestingProxies.add(device.device_id);
          try {
            const downloadResult = await measureDownloadSpeed(device);
            const uploadResult = await measureUploadSpeed(device);

            const latencyMs = downloadResult.latencyMs ?? uploadResult.latencyMs ?? null;
            const downloadSpeed = downloadResult.success ? downloadResult.speedMbps : 0;
            const uploadSpeed = uploadResult.success ? uploadResult.speedMbps : 0;

            // Record in speed_tests table (always insert, even on failure)
            // Capture device status at time of test to avoid ambiguity
            const deviceActive = mapProxyStatusToActive(device.proxy_status);
            await prisma.speedTest.create({
              data: {
                proxyId: device.device_id,
                timestamp: cycleTimestamp,
                downloadSpeedMbps: downloadSpeed,
                uploadSpeedMbps: uploadSpeed,
                latencyMs: latencyMs ?? undefined,
                error: downloadResult.error || uploadResult.error || undefined,
                // Device status at time of test
                deviceActive: deviceActive,
                wsStatus: device.ws_status || null,
                proxyStatus: device.proxy_status || null,
              },
            });
          } catch (err) {
            logger.error({ deviceId: device.device_id, error: err }, 'Unexpected error during speed test');
            // Capture device status even on error
            const deviceActive = mapProxyStatusToActive(device.proxy_status);
            await prisma.speedTest.create({
              data: {
                proxyId: device.device_id,
                timestamp: cycleTimestamp,
                downloadSpeedMbps: 0,
                uploadSpeedMbps: 0,
                latencyMs: null,
                error: `Unexpected error during speed test: ${err instanceof Error ? err.message : 'Unknown error'}`,
                // Device status at time of test
                deviceActive: deviceActive,
                wsStatus: device.ws_status || null,
                proxyStatus: device.proxy_status || null,
              },
            });
          } finally {
            currentlyTestingProxies.delete(device.device_id);
          }
        })
      );
    }
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      'Error during speed testing cycle'
    );
  }
}

/**
 * Starts the periodic speed test service
 */
export function startSpeedTestService(): void {
  if (!config.speedTest.enabled) {
    logger.info('Speed test service is disabled');
    return;
  }

  logger.info(
    { intervalMs: config.speedTest.intervalMs },
    'Starting speed test service'
  );

  // Run immediately on start
  void runSpeedTests();

  // Schedule periodic runs
  speedTestTimeout = setInterval(() => {
    void runSpeedTests();
  }, config.speedTest.intervalMs);
}

/**
 * Stops the speed test service
 */
export function stopSpeedTestService(): void {
  if (speedTestTimeout) {
    clearInterval(speedTestTimeout);
    speedTestTimeout = null;
  }
  logger.info('Speed test service stopped');
}
