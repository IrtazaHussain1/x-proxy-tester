/**
 * Proxy Testing Helper Module
 * 
 * Provides helper functions for testing proxies with comprehensive logging
 * and statistics collection.
 * 
 * @module helpers/test-proxy
 */

import { requestThroughProxy, buildProxyUrl } from '../clients/proxyClient';
import { logger } from '../lib/logger';
import { config } from '../config';
import type { Device, ProxyMetrics } from '../types';

/**
 * Tests a proxy device and logs comprehensive statistics
 * 
 * Makes a request through the device proxy to the configured IP checking service
 * and logs detailed metrics including:
 * - Response time
 * - Success/failure status
 * - Expected vs returned IP comparison
 * - Error details (if failed)
 * 
 * @param device - Device object with proxy credentials
 * @param expectedIp - Expected outbound IP (defaults to device.ip_address)
 * @returns Promise resolving to ProxyMetrics with test results
 * 
 * @example
 * ```typescript
 * const metrics = await testProxyWithStats(device);
 * if (metrics.success) {
 *   console.log(`IP: ${metrics.outboundIp}, Time: ${metrics.responseTimeMs}ms`);
 * }
 * ```
 */
export async function testProxyWithStats(
  device: Device,
  expectedIp?: string
): Promise<ProxyMetrics> {
  const testUrl = config.testing.targetUrl;
  const timeout = config.testing.requestTimeoutMs;
  const expected = expectedIp || device.ip_address;

  logger.debug(
    {
      deviceId: device.device_id,
      timeoutMs: timeout,
      timeoutSeconds: timeout / 1000,
      testUrl,
    },
    `Testing proxy with ${timeout / 1000}s timeout`
  );

  const startTime = Date.now();

  try {
    const metrics = await requestThroughProxy(device, testUrl, { timeout });
    
    const ipMatch = String(metrics.outboundIp).trim() === String(expected).trim();
    // if(!!metrics.outboundIp) debugger;
    const ipStatus = ipMatch ? 'MATCH' : 'MISMATCH';

    // Log success stats
    if (metrics.success) {
      const statusIcon = ipMatch ? '✅' : '⚠️';
      const proxyUrl = buildProxyUrl(device);
      const maskedProxyUrl = proxyUrl.replace(/:[^:@]+@/, ':****@');
      
      logger.info(
        {
          device: `${device.name} (${device.device_id})`,
          proxyUrl: maskedProxyUrl,
          proxyHost: `${device.relay_server_ip_address}:${device.port}`,
          responseTime: `${metrics.responseTimeMs}ms`,
          httpStatus: metrics.httpStatus,
          expectedIp: expected,
          returnedIp: metrics.outboundIp,
          ipMatch,
        },
        `${statusIcon} ${device.name} - ${ipStatus} (${metrics.responseTimeMs}ms)`
      );
    } else {
      // Log failure stats
      const proxyUrl = buildProxyUrl(device);
      const maskedProxyUrl = proxyUrl.replace(/:[^:@]+@/, ':****@');
      
      logger.error(
        {
          device: `${device.name} (${device.device_id})`,
          proxyUrl: maskedProxyUrl,
          proxyHost: `${device.relay_server_ip_address}:${device.port}`,
          responseTime: `${metrics.responseTimeMs}ms`,
          httpStatus: metrics.httpStatus,
          errorType: metrics.errorType,
          errorMessage: metrics.errorMessage,
          expectedIp: expected,
        },
        `❌ ${device.name} - FAILED: ${metrics.errorType || 'UNKNOWN'}`
      );
    }

    return metrics;
  } catch (error) {
    const duration = Date.now() - startTime;
    const proxyUrl = buildProxyUrl(device);
    const maskedProxyUrl = proxyUrl.replace(/:[^:@]+@/, ':****@');
    
    // Extract comprehensive error information
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const errorCode = (error as any)?.code;
    const errorName = errorObj.name;
    const errorMessage = errorObj.message || 'Unknown error';
    const errorStack = errorObj.stack;

    // Enhanced error logging with all available details
    logger.error(
      {
        device: `${device.name} (${device.device_id})`,
        proxyUrl: maskedProxyUrl,
        proxyHost: `${device.relay_server_ip_address}:${device.port}`,
        totalTimeMs: duration,
        errorCode,
        errorName,
        errorMessage,
        errorStack,
        expectedIp: expected,
        errorCause: (error as any)?.cause,
      },
      'Proxy test exception - unhandled error in test wrapper'
    );

    // Try to classify the error if possible
    let errorType: 'OTHER' | 'TIMEOUT' | 'CONNECTION_REFUSED' | 'DNS_ERROR' | 'HTTP_ERROR' | 'TLS_ERROR' | 'CONNECTION_RESET' = 'OTHER';
    let classifiedMessage = errorMessage;
    
    const errorStr = errorMessage.toLowerCase();
    
    // Quick classification attempt
    if (errorCode === 'ETIMEDOUT' || errorCode === 'UND_ERR_TIMEOUT' || errorName === 'TimeoutError' || errorStr.includes('timeout')) {
      errorType = 'TIMEOUT';
    } else if (errorCode === 'ECONNREFUSED' || errorCode === 'ECONNRESET' || errorStr.includes('connection')) {
      errorType = 'CONNECTION_REFUSED';
    } else if (errorCode === 'ENOTFOUND' || errorCode === 'EAI_AGAIN' || errorStr.includes('dns') || errorStr.includes('getaddrinfo')) {
      errorType = 'DNS_ERROR';
    } else if (errorCode === 'EPROTO' || errorCode === 'UND_ERR_TLS' || errorStr.includes('tls') || errorStr.includes('ssl')) {
      errorType = 'TLS_ERROR';
    }
    
    // Include error code in message if available for better debugging
    if (errorType === 'OTHER' && errorCode) {
      classifiedMessage = `[${errorCode}] ${errorMessage}`;
    }

    // Return error metrics
    return {
      requestUrl: testUrl,
      proxyHost: device.relay_server_ip_address, // Use relay server IP
      proxyPort: device.port,
      responseTimeMs: duration,
      success: false,
      errorType,
      errorMessage: classifiedMessage,
      timestamp: new Date(),
    };
  }
}

/**
 * Test multiple proxies and return aggregated stats
 * @param devices - Array of devices to test
 * @returns Array of metrics for each device
 */
export async function testMultipleProxies(
  devices: Device[]
): Promise<Array<ProxyMetrics & { deviceId: string; deviceName: string }>> {
  logger.info({ count: devices.length }, 'Starting batch proxy tests');

  const results = await Promise.allSettled(
    devices.map(async (device) => {
      const metrics = await testProxyWithStats(device);
      return {
        ...metrics,
        deviceId: device.device_id,
        deviceName: device.name,
      };
    })
  );

  const metrics = results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      const device = devices[index];
      const error = result.reason;
      const errorCode = error?.code;
      const errorName = error?.name;
      const errorMessage = error?.message || 'Unknown error';
      
      // Try to classify the error
      let errorType: 'OTHER' | 'TIMEOUT' | 'CONNECTION_REFUSED' | 'DNS_ERROR' | 'HTTP_ERROR' | 'TLS_ERROR' | 'CONNECTION_RESET' = 'OTHER';
      let classifiedMessage = errorMessage;
      
      const errorStr = errorMessage.toLowerCase();
      
      if (errorCode === 'ETIMEDOUT' || errorCode === 'UND_ERR_TIMEOUT' || errorName === 'TimeoutError' || errorStr.includes('timeout')) {
        errorType = 'TIMEOUT';
      } else if (errorCode === 'ECONNREFUSED' || errorCode === 'ECONNRESET' || errorStr.includes('connection')) {
        errorType = 'CONNECTION_REFUSED';
      } else if (errorCode === 'ENOTFOUND' || errorCode === 'EAI_AGAIN' || errorStr.includes('dns')) {
        errorType = 'DNS_ERROR';
      } else if (errorCode === 'EPROTO' || errorCode === 'UND_ERR_TLS' || errorStr.includes('tls')) {
        errorType = 'TLS_ERROR';
      }
      
      // Include error code in message if available
      if (errorType === 'OTHER' && errorCode) {
        classifiedMessage = `[${errorCode}] ${errorMessage}`;
      }
      
      logger.error(
        {
          deviceId: device.device_id,
          deviceName: device.name,
          errorCode,
          errorName,
          errorMessage,
          errorStack: error?.stack,
        },
        'Batch test failed for device'
      );
      
      return {
        requestUrl: config.testing.targetUrl,
        proxyHost: device.relay_server_ip_address,
        proxyPort: device.port,
        responseTimeMs: 0,
        success: false,
        errorType: errorType,
        errorMessage: classifiedMessage,
        timestamp: new Date(),
        deviceId: device.device_id,
        deviceName: device.name,
      };
    }
  });

  // Log summary stats
  const successful = metrics.filter((m) => m.success).length;
  const failed = metrics.length - successful;
  const avgResponseTime =
    metrics.reduce((sum, m) => sum + m.responseTimeMs, 0) / metrics.length;

  logger.info(
    {
      total: metrics.length,
      successful,
      failed,
      successRate: ((successful / metrics.length) * 100).toFixed(2) + '%',
      avgResponseTimeMs: Math.round(avgResponseTime),
    },
    'Batch proxy tests completed'
  );

  return metrics;
}

/**
 * Format proxy test stats for console output
 * @param metrics - Proxy metrics object
 * @param expectedIp - Expected IP address
 * @returns Formatted string
 */
export function formatProxyTestStats(
  metrics: ProxyMetrics,
  expectedIp?: string
): string {
  const status = metrics.success ? '✓' : '✗';
  const statusText = metrics.success ? 'SUCCESS' : 'FAILED';
  const ipInfo = metrics.outboundIp
    ? ` | IP: ${metrics.outboundIp}${expectedIp ? ` (expected: ${expectedIp})` : ''}`
    : '';
  const ipMatch =
    expectedIp && metrics.outboundIp
      ? metrics.outboundIp === expectedIp
        ? ' ✓ MATCH'
        : ' ✗ MISMATCH'
      : '';
  const errorInfo = metrics.errorMessage ? ` | Error: ${metrics.errorMessage}` : '';

  return `${status} ${statusText} | ${metrics.proxyHost}:${metrics.proxyPort} | ${metrics.responseTimeMs}ms | ${metrics.httpStatus || 'N/A'}${ipInfo}${ipMatch}${errorInfo}`;
}

