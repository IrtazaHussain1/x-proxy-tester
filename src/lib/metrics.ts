/**
 * Metrics Collection Module
 * 
 * Collects and exposes application metrics in Prometheus format.
 * Tracks request counts, success rates, response times, and system health.
 * 
 * @module lib/metrics
 */

/**
 * Metrics storage
 */
interface Metrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  requestDuration: number[];
  activeProxies: number;
  databaseQueries: number;
  databaseErrors: number;
  apiCalls: number;
  apiErrors: number;
}

const metrics: Metrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  requestDuration: [],
  activeProxies: 0,
  databaseQueries: 0,
  databaseErrors: 0,
  apiCalls: 0,
  apiErrors: 0,
};

/**
 * Record a proxy request
 */
export function recordRequest(success: boolean, durationMs: number): void {
  metrics.totalRequests++;
  if (success) {
    metrics.successfulRequests++;
  } else {
    metrics.failedRequests++;
  }
  
  // Keep only last 1000 durations for percentile calculation
  metrics.requestDuration.push(durationMs);
  if (metrics.requestDuration.length > 1000) {
    metrics.requestDuration.shift();
  }
}

/**
 * Record active proxy count
 */
export function setActiveProxies(count: number): void {
  metrics.activeProxies = count;
}

/**
 * Record database query
 */
export function recordDatabaseQuery(): void {
  metrics.databaseQueries++;
}

/**
 * Record database error
 */
export function recordDatabaseError(): void {
  metrics.databaseErrors++;
}

/**
 * Record API call
 */
export function recordApiCall(): void {
  metrics.apiCalls++;
}

/**
 * Record API error
 */
export function recordApiError(): void {
  metrics.apiErrors++;
}

/**
 * Calculate percentile from array
 */
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)] || 0;
}

/**
 * Get current metrics snapshot
 */
export function getMetrics(): Metrics {
  return { ...metrics };
}

/**
 * Get success rate percentage
 */
export function getSuccessRate(): number {
  if (metrics.totalRequests === 0) return 0;
  return (metrics.successfulRequests / metrics.totalRequests) * 100;
}

/**
 * Get average response time
 */
export function getAverageResponseTime(): number {
  if (metrics.requestDuration.length === 0) return 0;
  const sum = metrics.requestDuration.reduce((a, b) => a + b, 0);
  return sum / metrics.requestDuration.length;
}

/**
 * Get P50, P95, P99 response times
 */
export function getResponseTimePercentiles(): {
  p50: number;
  p95: number;
  p99: number;
} {
  return {
    p50: percentile(metrics.requestDuration, 50),
    p95: percentile(metrics.requestDuration, 95),
    p99: percentile(metrics.requestDuration, 99),
  };
}

/**
 * Export metrics in Prometheus format
 */
export function exportPrometheusMetrics(): string {
  const successRate = getSuccessRate();
  const avgResponseTime = getAverageResponseTime();
  const percentiles = getResponseTimePercentiles();

  const lines: string[] = [
    '# HELP proxy_tester_requests_total Total number of proxy test requests',
    '# TYPE proxy_tester_requests_total counter',
    `proxy_tester_requests_total ${metrics.totalRequests}`,
    '',
    '# HELP proxy_tester_requests_successful_total Total number of successful requests',
    '# TYPE proxy_tester_requests_successful_total counter',
    `proxy_tester_requests_successful_total ${metrics.successfulRequests}`,
    '',
    '# HELP proxy_tester_requests_failed_total Total number of failed requests',
    '# TYPE proxy_tester_requests_failed_total counter',
    `proxy_tester_requests_failed_total ${metrics.failedRequests}`,
    '',
    '# HELP proxy_tester_success_rate Success rate percentage',
    '# TYPE proxy_tester_success_rate gauge',
    `proxy_tester_success_rate ${successRate}`,
    '',
    '# HELP proxy_tester_response_time_avg_ms Average response time in milliseconds',
    '# TYPE proxy_tester_response_time_avg_ms gauge',
    `proxy_tester_response_time_avg_ms ${avgResponseTime}`,
    '',
    '# HELP proxy_tester_response_time_p50_ms P50 response time in milliseconds',
    '# TYPE proxy_tester_response_time_p50_ms gauge',
    `proxy_tester_response_time_p50_ms ${percentiles.p50}`,
    '',
    '# HELP proxy_tester_response_time_p95_ms P95 response time in milliseconds',
    '# TYPE proxy_tester_response_time_p95_ms gauge',
    `proxy_tester_response_time_p95_ms ${percentiles.p95}`,
    '',
    '# HELP proxy_tester_response_time_p99_ms P99 response time in milliseconds',
    '# TYPE proxy_tester_response_time_p99_ms gauge',
    `proxy_tester_response_time_p99_ms ${percentiles.p99}`,
    '',
    '# HELP proxy_tester_active_proxies Number of active proxies being tested',
    '# TYPE proxy_tester_active_proxies gauge',
    `proxy_tester_active_proxies ${metrics.activeProxies}`,
    '',
    '# HELP proxy_tester_database_queries_total Total number of database queries',
    '# TYPE proxy_tester_database_queries_total counter',
    `proxy_tester_database_queries_total ${metrics.databaseQueries}`,
    '',
    '# HELP proxy_tester_database_errors_total Total number of database errors',
    '# TYPE proxy_tester_database_errors_total counter',
    `proxy_tester_database_errors_total ${metrics.databaseErrors}`,
    '',
    '# HELP proxy_tester_api_calls_total Total number of API calls',
    '# TYPE proxy_tester_api_calls_total counter',
    `proxy_tester_api_calls_total ${metrics.apiCalls}`,
    '',
    '# HELP proxy_tester_api_errors_total Total number of API errors',
    '# TYPE proxy_tester_api_errors_total counter',
    `proxy_tester_api_errors_total ${metrics.apiErrors}`,
    '',
  ];

  return lines.join('\n');
}

/**
 * Reset all metrics (useful for testing)
 */
export function resetMetrics(): void {
  metrics.totalRequests = 0;
  metrics.successfulRequests = 0;
  metrics.failedRequests = 0;
  metrics.requestDuration = [];
  metrics.activeProxies = 0;
  metrics.databaseQueries = 0;
  metrics.databaseErrors = 0;
  metrics.apiCalls = 0;
  metrics.apiErrors = 0;
}

