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

let speedTestTimeout: NodeJS.Timeout | null = null;
let isSpeedTesting = false;

/**
 * Measures download speed through a proxy
 */
async function measureDownloadSpeed(device: any): Promise<{ speedMbps: number; success: boolean; error?: string }> {
  const proxyUrl = buildProxyUrl(device);
  const agent = new ProxyAgent(proxyUrl);

  const start = Date.now();
  try {
    logger.debug({ deviceId: device.device_id, url: config.speedTest.targetUrl }, 'Starting download speed measurement');
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
        error: `HTTP Error ${response.statusCode}` 
      };
    }

    // Read the stream to measure speed
    let totalBytes = 0;
    for await (const chunk of response.body) {
      totalBytes += chunk.length;
    }

    const durationSeconds = (Date.now() - start) / 1000;
    if (durationSeconds <= 0) return { speedMbps: 0, success: false, error: 'Duration too short' };
    
    const speedMbps = (totalBytes * 8) / (1024 * 1024) / durationSeconds;

    return { speedMbps, success: true };
  } catch (error) {
    return { 
      speedMbps: 0, 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown download speed test error' 
    };
  }
}

/**
 * Measures upload speed through a proxy by sending a chunk of data
 */
async function measureUploadSpeed(device: any): Promise<{ speedMbps: number; success: boolean; error?: string }> {
  const proxyUrl = buildProxyUrl(device);
  const agent = new ProxyAgent(proxyUrl);
  
  // Create a 1MB dummy buffer for uploading
  const MB = 1024 * 1024;
  const dummyData = Buffer.alloc(MB, 'x');

  const start = Date.now();
  try {
    logger.debug({ deviceId: device.device_id, url: config.speedTest.uploadTargetUrl }, 'Starting upload speed measurement');
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
        error: `HTTP Error ${response.statusCode}` 
      };
    }

    const durationSeconds = (Date.now() - start) / 1000;
    if (durationSeconds <= 0) return { speedMbps: 0, success: false, error: 'Duration too short' };
    
    const speedMbps = (dummyData.length * 8) / (1024 * 1024) / durationSeconds;

    return { speedMbps, success: true };
  } catch (error) {
    return { 
      speedMbps: 0, 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown upload speed test error' 
    };
  }
}

/**
 * Runs a speed test for all active proxies
 */
export async function runSpeedTests(): Promise<void> {
  if (isSpeedTesting) {
    logger.warn('Speed test already in progress, skipping');
    return;
  }

  const dbHealth = await checkDatabaseHealth();
  if (!dbHealth.connected) {
    logger.error('Database not connected, skipping speed tests');
    return;
  }

  isSpeedTesting = true;
  logger.info('Starting periodic speed tests for all proxies');

  try {
    const devices = await getAllDevices();
    const activeDevices = devices.filter(d => d.proxy_status === 'active');

    logger.info({ total: devices.length, active: activeDevices.length }, `Found ${activeDevices.length} active proxies for speed testing`);

    if (activeDevices.length === 0) {
      logger.warn('No active proxies found for speed testing');
      return;
    }

    // batch processing to avoid overwhelming system
    const batchSize = config.speedTest.maxConcurrentTests;
    for (let i = 0; i < activeDevices.length; i += batchSize) {
      const batch = activeDevices.slice(i, i + batchSize);
      await Promise.all(batch.map(async (device) => {
        const downloadResult = await measureDownloadSpeed(device);
        const uploadResult = await measureUploadSpeed(device);
        
        if (downloadResult.success || uploadResult.success) {
          logger.info(
            { 
              deviceId: device.device_id, 
              downloadMbps: downloadResult.speedMbps.toFixed(2),
              uploadMbps: uploadResult.speedMbps.toFixed(2)
            },
            `Speed test completed for ${device.name}: DL: ${downloadResult.speedMbps.toFixed(2)} Mbps, UL: ${uploadResult.speedMbps.toFixed(2)} Mbps`
          );

          await prisma.proxy.update({
            where: { deviceId: device.device_id },
            data: {
              lastSpeedTestAt: new Date(),
              downloadSpeedMbps: downloadResult.speedMbps,
              uploadSpeedMbps: uploadResult.speedMbps,
            }
          });

          // Also record in proxy_requests for history
          await prisma.proxyRequest.create({
            data: {
              proxyId: device.device_id,
              targetUrl: config.speedTest.targetUrl,
              status: 'SUCCESS',
              responseTimeMs: Math.round(downloadResult.speedMbps), 
              downloadSpeedMbps: downloadResult.speedMbps,
              uploadSpeedMbps: uploadResult.speedMbps,
              source: 'speed_test'
            }
          });
        } else {
          logger.error(
            { 
              deviceId: device.device_id, 
              downloadError: downloadResult.error,
              uploadError: uploadResult.error
            },
            `Speed test failed for ${device.name}`
          );
        }
      }));
    }

    logger.info('All speed tests completed');
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      'Error during speed testing cycle'
    );
  } finally {
    isSpeedTesting = false;
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
