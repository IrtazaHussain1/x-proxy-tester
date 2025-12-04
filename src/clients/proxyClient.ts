/**
 * Proxy Client Module
 * 
 * Handles HTTP requests through device proxies using undici's ProxyAgent.
 * Provides functions to build proxy URLs, create proxy agents, and make
 * requests through proxies with comprehensive error handling and metrics collection.
 * 
 * @module clients/proxyClient
 */

import { request, ProxyAgent } from 'undici';
import type { Device, ProxyMetrics } from '../types';
import { logger } from '../lib/logger';
import { config } from '../config';

/**
 * Builds a proxy URL from device credentials
 * 
 * Uses `relay_server_ip_address` as the proxy host (not `ip_address`).
 * The `ip_address` field represents the device's mobile IP that we expect
 * to see externally when making requests through the proxy.
 * 
 * @param device - Device object containing proxy credentials
 * @returns Proxy URL string in format: `http://username:password@host:port`
 * 
 * @example
 * ```typescript
 * const url = buildProxyUrl({
 *   username: 'user',
 *   password: 'pass',
 *   relay_server_ip_address: '1.2.3.4',
 *   port: 8080
 * });
 * // Returns: "http://user:pass@1.2.3.4:8080"
 * ```
 */
export function buildProxyUrl(device: Device): string {
  // Use relay_server_ip_address as proxy host, not ip_address
  // ip_address is the device's mobile IP we expect to see externally
  return `http://${encodeURIComponent(device.username)}:${encodeURIComponent(device.password)}@${device.relay_server_ip_address}:${device.port}`;
}

/**
 * Creates a ProxyAgent instance for making requests through a device proxy
 * 
 * @param device - Device object with proxy credentials
 * @returns Configured ProxyAgent instance ready to use with undici requests
 * 
 * @example
 * ```typescript
 * const agent = createProxyAgent(device);
 * const response = await request(url, { dispatcher: agent });
 * ```
 */
export function createProxyAgent(device: Device): ProxyAgent {
  const proxyUrl = buildProxyUrl(device);
  return new ProxyAgent(proxyUrl);
}

/**
 * Makes an HTTP request through a device proxy and returns comprehensive metrics
 * 
 * This function:
 * - Routes request through the device's proxy server
 * - Extracts outbound IP from response (if available)
 * - Handles various error types (timeout, connection, DNS, HTTP, TLS)
 * - Returns detailed metrics including response time and status
 * 
 * @param device - Device object with proxy credentials
 * @param url - Target URL to request through the proxy
 * @param options - Optional request configuration
 * @param options.method - HTTP method (default: 'GET')
 * @param options.data - Request body data
 * @param options.headers - Additional HTTP headers
 * @param options.timeout - Request timeout in milliseconds (default: from config)
 * @returns Promise resolving to ProxyMetrics with test results
 * 
 * @example
 * ```typescript
 * const metrics = await requestThroughProxy(device, 'https://api.ipify.org?format=json', {
 *   timeout: 30000
 * });
 * console.log(`Response time: ${metrics.responseTimeMs}ms`);
 * console.log(`Outbound IP: ${metrics.outboundIp}`);
 * ```
 */
export async function requestThroughProxy(
  device: Device,
  url: string,
  options?: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    data?: any;
    headers?: Record<string, string>;
    timeout?: number;
  }
): Promise<ProxyMetrics> {
  const startTime = Date.now();
  const proxyUrl = buildProxyUrl(device);
  
  // Log the compiled proxy URL for debugging (password hidden)
  const maskedProxyUrl = proxyUrl.replace(/:[^:@]+@/, ':****@');
  logger.info({
    device: device.name,
    deviceId: device.device_id,
    proxyUrl: maskedProxyUrl,
    proxyUrlFull: proxyUrl, // Full URL for debugging
    expectedIp: device.ip_address,
    proxyHost: device.relay_server_ip_address,
    proxyPort: device.port,
    targetUrl: url,
  }, 'Making proxy request');
  
  const proxyAgent = createProxyAgent(device);
  const timeout = options?.timeout || config.testing.requestTimeoutMs;

  // logger.debug(
  //   {
  //     deviceId: device.device_id,
  //     timeoutMs: timeout,
  //     url,
  //   },
  //   `Making request with ${timeout}ms timeout`
  // );

  try {
    const response = await request(url, {
      dispatcher: proxyAgent,
      method: options?.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
        ...options?.headers,
      },
      headersTimeout: timeout, // 30 seconds timeout
      bodyTimeout: timeout, // 30 seconds timeout
    });

    const responseTimeMs = Date.now() - startTime;
    const statusCode = response.statusCode;
    
    // Handle response body more safely
    let body: any;
    try {
      const contentType = response.headers['content-type'] || '';
      if (contentType.includes('application/json')) {
        body = await response.body.json();
      } else {
        // Try to parse as text first, then JSON
        const text = await response.body.text();
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
    } catch (bodyError: any) {
      logger.warn(
        {
          deviceId: device.device_id,
          error: bodyError?.message,
          statusCode,
        },
        'Failed to parse response body'
      );
      body = null;
    }

    // Try to extract outbound IP from response (if it's an IP checking service)
    let outboundIp: string | undefined;
    if (body) {
      if (typeof body === 'string') {
        // Try to extract IP from plain text response
        const ipMatch = body.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
        if (ipMatch) {
          outboundIp = ipMatch[0];
        }
      } else if (typeof body === 'object') {
        // Try common IP fields in JSON responses
        outboundIp =
          (body as any).ip ||
          (body as any).origin ||
          (body as any).query ||
          (body as any).outboundIp;
      }
    }

    const success = statusCode >= 200 && statusCode < 400;

    return {
      requestUrl: url,
      proxyHost: device.relay_server_ip_address,
      proxyPort: device.port,
      responseTimeMs,
      httpStatus: statusCode,
      success,
      outboundIp,
      timestamp: new Date(),
    };
  } catch (error: any) {
    const responseTimeMs = Date.now() - startTime;
    
    // Enhanced error logging
    const errorDetails: any = {
      device: device.name,
      deviceId: device.device_id,
      proxyUrl: maskedProxyUrl,
      proxyHost: device.relay_server_ip_address,
      proxyPort: device.port,
      targetUrl: url,
      errorCode: error?.code,
      errorMessage: error?.message || String(error),
      errorName: error?.name,
    };
    
    logger.error(errorDetails, 'Proxy request failed');

    let errorType: ProxyMetrics['errorType'] = 'OTHER';
    let errorMessage = error?.message || String(error);

    const code = error?.code;
    const errorStr = errorMessage.toLowerCase();
    
    // Check for HTTP protocol errors
    if (errorStr.includes('http') && (errorStr.includes('protocol') || errorStr.includes('version'))) {
      errorType = 'HTTP_ERROR';
      errorMessage = `Invalid HTTP response from proxy: ${errorMessage}`;
    } else if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
      errorType = 'CONNECTION_REFUSED';
    } else if (code === 'ETIMEDOUT' || code === 'UND_ERR_TIMEOUT' || error?.name === 'TimeoutError') {
      errorType = 'TIMEOUT';
    } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'UND_ERR_DNS') {
      errorType = 'DNS_ERROR';
    } else if (code === 'EPROTO' || code === 'UND_ERR_TLS') {
      errorType = 'TLS_ERROR';
    } else if (code === 'UND_ERR_SOCKET' || code === 'UND_ERR_INVALID_ARG') {
      errorType = 'CONNECTION_RESET';
    } else if (error?.statusCode) {
      errorType = 'HTTP_ERROR';
      errorMessage = `${error.statusCode} - ${error.statusText || 'HTTP Error'}`;
    }

    return {
      requestUrl: url,
      proxyHost: device.relay_server_ip_address,
      proxyPort: device.port,
      responseTimeMs,
      httpStatus: error?.statusCode,
      success: false,
      errorType,
      errorMessage,
      timestamp: new Date(),
    };
  }
}

/**
 * Convenience function to test a proxy using an IP checking service
 * 
 * @param device - Device object with proxy credentials
 * @param testUrl - URL to test (default: 'https://api.ipify.org?format=json')
 * @returns Promise resolving to ProxyMetrics
 */
export async function testProxy(
  device: Device,
  testUrl: string = 'https://api.ipify.org?format=json'
): Promise<ProxyMetrics> {
  return requestThroughProxy(device, testUrl);
}

/**
 * Formats proxy metrics into a human-readable string for logging/display
 * 
 * @param metrics - Proxy metrics object
 * @returns Formatted string with status, response time, IP, and error info
 * 
 * @example
 * ```typescript
 * const formatted = formatMetrics(metrics);
 * // Returns: "✓ SUCCESS | 1.2.3.4:8080 | 1500ms | 200 | IP: 5.6.7.8"
 * ```
 */
export function formatMetrics(metrics: ProxyMetrics): string {
  const status = metrics.success ? '✓' : '✗';
  const statusText = metrics.success ? 'SUCCESS' : 'FAILED';
  const ipInfo = metrics.outboundIp ? ` | IP: ${metrics.outboundIp}` : '';
  const errorInfo = metrics.errorMessage ? ` | Error: ${metrics.errorMessage}` : '';

  return `${status} ${statusText} | ${metrics.proxyHost}:${metrics.proxyPort} | ${metrics.responseTimeMs}ms | ${metrics.httpStatus || 'N/A'}${ipInfo}${errorInfo}`;
}

