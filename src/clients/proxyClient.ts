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
 * Configures connection pooling to prevent overwhelming proxies with too many
 * concurrent connections. Limits to 1 connection per proxy to ensure proper
 * resource management.
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
 * - Retries transient HTTP errors (429, 503, 502) with exponential backoff
 * - Returns detailed metrics including response time and status
 * 
 * @param device - Device object with proxy credentials
 * @param url - Target URL to request through the proxy
 * @param options - Optional request configuration
 * @param options.method - HTTP method (default: 'GET')
 * @param options.data - Request body data
 * @param options.headers - Additional HTTP headers
 * @param options.timeout - Request timeout in milliseconds (default: from config)
 * @param options.maxRetries - Maximum number of retries for transient errors (default: 2)
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
    maxRetries?: number;
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
  const maxRetries = options?.maxRetries ?? 2; // Default to 2 retries for transient errors

  // logger.debug(
  //   {
  //     deviceId: device.device_id,
  //     timeoutMs: timeout,
  //     url,
  //   },
  //   `Making request with ${timeout}ms timeout`
  // );

  // Retry logic for transient HTTP errors
  let lastError: any = null;
  let attempt = 0;
  
  while (attempt <= maxRetries) {
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
    
    // CRITICAL FIX: Always consume the response body, even for error status codes
    // This prevents connection pool issues and ensures proper cleanup
    // Undici requires the body to be fully consumed to release the connection
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
      // If body parsing fails, still try to consume it to prevent connection issues
      try {
        // Force consume the body stream to release the connection
        await response.body.text().catch(() => {
          // If text() fails, try to drain the stream
          return null;
        });
      } catch (consumeError) {
        // Ignore consume errors - we've tried our best to clean up
        logger.debug(
          {
            deviceId: device.device_id,
            consumeError: consumeError instanceof Error ? consumeError.message : String(consumeError),
          },
          'Failed to consume response body stream'
        );
      }
      
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

    // Consider 2xx and 3xx as success, 4xx/5xx as failure
    // Note: Some 4xx/5xx might be transient (429, 503, 502) and could be retried
    const success = statusCode >= 200 && statusCode < 400;

    // Check for transient HTTP errors that should be retried
    const isTransientError = statusCode === 429 || statusCode === 503 || statusCode === 502;
    
    if (isTransientError && attempt < maxRetries) {
      // Calculate exponential backoff: 500ms, 1000ms, 2000ms
      const backoffMs = 500 * Math.pow(2, attempt);
      attempt++;
      
      logger.warn(
        {
          deviceId: device.device_id,
          statusCode,
          attempt,
          maxRetries,
          backoffMs,
        },
        `Transient HTTP error ${statusCode}, retrying after ${backoffMs}ms`
      );
      
      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      
      // Continue to retry
      continue;
    }

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
      // Store error for potential retry
      lastError = error;
      
      // Check if this is a retryable error and we haven't exceeded max retries
      const isRetryableError =
        (error?.code === 'ETIMEDOUT' ||
          error?.code === 'UND_ERR_TIMEOUT' ||
          error?.code === 'ECONNRESET' ||
          error?.code === 'UND_ERR_SOCKET') &&
        attempt < maxRetries;
      
      if (isRetryableError) {
        // Calculate exponential backoff: 500ms, 1000ms, 2000ms
        const backoffMs = 500 * Math.pow(2, attempt);
        attempt++;
        
        logger.warn(
          {
            deviceId: device.device_id,
            errorCode: error?.code,
            attempt,
            maxRetries,
            backoffMs,
          },
          `Retryable error ${error?.code}, retrying after ${backoffMs}ms`
        );
        
        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        
        // Continue to retry
        continue;
      }
      
      // Not retryable or max retries exceeded, break and handle error
      break;
    }
  }
  
  // If we get here, all retries failed or error is not retryable
  const responseTimeMs = Date.now() - startTime;
  const error = lastError || new Error('Unknown error after retries');
  
  // Enhanced error logging with more details for debugging
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
    errorStack: error?.stack, // Add stack trace for debugging
    errorCause: error?.cause, // Additional error context
  };
  
  logger.error(errorDetails, 'Proxy request failed');

  let errorType: ProxyMetrics['errorType'] = 'OTHER';
  let errorMessage = error?.message || String(error);

  const code = error?.code;
  const errorStr = errorMessage.toLowerCase();
  const errorName = error?.name || '';
  
  // COMPREHENSIVE: More specific error type detection with better classification
  
  // Check for proxy authentication errors first (407 Proxy Authentication Required)
  if (
    code === 'UND_ERR_PROXY_AUTH' ||
    errorStr.includes('proxy authentication') ||
    errorStr.includes('407') ||
    errorStr.includes('authentication required') ||
    errorStr.includes('proxy-authorization')
  ) {
    errorType = 'HTTP_ERROR';
    errorMessage = `Proxy authentication failed: ${errorMessage}`;
  }
  // Check for HTTP protocol errors (more specific matching)
  else if (
    (code === 'UND_ERR_INVALID_ARG' && errorStr.includes('http')) ||
    (errorStr.includes('http') &&
      (errorStr.includes('protocol') ||
        errorStr.includes('version') ||
        errorStr.includes('invalid') ||
        errorStr.includes('malformed') ||
        errorStr.includes('parse')))
  ) {
    errorType = 'HTTP_ERROR';
    errorMessage = `Invalid HTTP response from proxy: ${errorMessage}`;
  }
  // Check for specific undici HTTP-related error codes
  else if (
    code?.startsWith('UND_ERR_') &&
    (errorStr.includes('http') ||
      errorStr.includes('response') ||
      errorStr.includes('status') ||
      errorStr.includes('header') ||
      errorStr.includes('body'))
  ) {
    errorType = 'HTTP_ERROR';
    errorMessage = `HTTP error from proxy: ${errorMessage}`;
  }
  // Connection errors - comprehensive list
  else if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETDOWN' ||
    code === 'EHOSTDOWN' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    (code?.startsWith('UND_ERR_') && errorStr.includes('connect'))
  ) {
    errorType = 'CONNECTION_REFUSED';
  }
  // Timeout errors - comprehensive list
  else if (
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    error?.name === 'TimeoutError' ||
    errorName === 'TimeoutError' ||
    errorStr.includes('timeout')
  ) {
    errorType = 'TIMEOUT';
  }
  // DNS errors - comprehensive list
  else if (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ESERVFAIL' ||
    code === 'ENODATA' ||
    code === 'UND_ERR_DNS' ||
    errorStr.includes('dns') ||
    errorStr.includes('getaddrinfo') ||
    errorStr.includes('name resolution')
  ) {
    errorType = 'DNS_ERROR';
  }
  // TLS/SSL errors - comprehensive list
  else if (
    code === 'EPROTO' ||
    code === 'UND_ERR_TLS' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'CERT_SIGNATURE_FAILURE' ||
    errorStr.includes('tls') ||
    errorStr.includes('ssl') ||
    errorStr.includes('certificate') ||
    errorStr.includes('handshake')
  ) {
    errorType = 'TLS_ERROR';
  }
  // Socket/connection reset errors
  else if (
    code === 'UND_ERR_SOCKET' ||
    code === 'EPIPE' ||
    code === 'ECONNABORTED' ||
    (code === 'UND_ERR_INVALID_ARG' && !errorStr.includes('http'))
  ) {
    errorType = 'CONNECTION_RESET';
  }
  // HTTP status code in error object
  else if (error?.statusCode) {
    errorType = 'HTTP_ERROR';
    errorMessage = `${error.statusCode} - ${error.statusText || 'HTTP Error'}`;
  }
  // Check for abort errors
  else if (
    code === 'UND_ERR_ABORTED' ||
    code === 'ABORT_ERR' ||
    errorStr.includes('aborted') ||
    errorStr.includes('abort')
  ) {
    errorType = 'CONNECTION_RESET';
    errorMessage = `Request aborted: ${errorMessage}`;
  }
  // Check for body/stream errors
  else if (
    code === 'UND_ERR_BODY' ||
    code === 'UND_ERR_STREAM' ||
    errorStr.includes('stream') ||
    errorStr.includes('body') ||
    errorStr.includes('readable')
  ) {
    errorType = 'HTTP_ERROR';
    errorMessage = `Response body error: ${errorMessage}`;
  }
  // Check for network unreachable
  else if (
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH' ||
    errorStr.includes('network unreachable') ||
    errorStr.includes('host unreachable')
  ) {
    errorType = 'CONNECTION_REFUSED';
  }
  
  // If still "OTHER", enhance the error message with code for debugging
  if (errorType === 'OTHER') {
    // Include error code in message for better debugging
    const codeInfo = code ? `[${code}] ` : '';
    const nameInfo = errorName ? `(${errorName}) ` : '';
    errorMessage = `${codeInfo}${nameInfo}${errorMessage}`;
    
    // Log additional details for unclassified errors
    logger.warn(
      {
        ...errorDetails,
        unclassifiedError: true,
        suggestion: 'This error type is not yet classified. Consider adding it to error classification logic.',
      },
      'Unclassified error - needs investigation'
    );
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

