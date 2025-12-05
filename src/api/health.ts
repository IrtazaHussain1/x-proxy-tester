/**
 * Health Check Module
 * 
 * Provides health check endpoints for monitoring application status.
 * Checks database connectivity, system resources, and overall health.
 * 
 * @module api/health
 */

import { checkDatabaseHealth } from '../lib/db';
import { logger } from '../lib/logger';
import { getMetrics, getSuccessRate, getAverageResponseTime } from '../lib/metrics';
import { getTestingStatus } from '../services/continuous-proxy-tester';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  database: {
    status: 'connected' | 'disconnected' | 'error';
    latency?: number;
  };
  system: {
    memory: {
      used: number;
      total: number;
      percentage: number;
    };
  };
  metrics: {
    totalRequests: number;
    successRate: number;
    averageResponseTime: number;
    activeProxies: number;
  };
  testing: {
    isRunning: boolean;
    activeDevices: number;
  };
}

/**
 * Check database connectivity
 */
async function checkDatabase(): Promise<{
  status: 'connected' | 'disconnected' | 'error';
  latency?: number;
}> {
  const health = await checkDatabaseHealth();
  
  if (health.connected) {
    return {
      status: 'connected',
      latency: health.latency,
    };
  } else {
    return {
      status: 'error',
    };
  }
}

/**
 * Get system memory usage
 */
function getMemoryUsage(): {
  used: number;
  total: number;
  percentage: number;
} {
  const usage = process.memoryUsage();
  const used = usage.heapUsed;
  const total = usage.heapTotal;
  const percentage = (used / total) * 100;

  return {
    used: Math.round(used / 1024 / 1024), // MB
    total: Math.round(total / 1024 / 1024), // MB
    percentage: Math.round(percentage * 100) / 100,
  };
}

/**
 * Get overall health status
 */
export async function getHealthStatus(): Promise<HealthStatus> {
  const startTime = process.uptime();
  const database = await checkDatabase();
  const memory = getMemoryUsage();
  const metrics = getMetrics();
  const testing = getTestingStatus();

  // Determine overall status
  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

  if (database.status !== 'connected') {
    status = 'unhealthy';
  } else if (memory.percentage > 90) {
    status = 'degraded';
  } else if (getSuccessRate() < 50 && metrics.totalRequests > 100) {
    status = 'degraded';
  }

  return {
    status,
    timestamp: new Date().toISOString(),
    uptime: Math.round(startTime),
    database,
    system: {
      memory,
    },
    metrics: {
      totalRequests: metrics.totalRequests,
      successRate: getSuccessRate(),
      averageResponseTime: getAverageResponseTime(),
      activeProxies: metrics.activeProxies,
    },
    testing: {
      isRunning: testing.isRunning,
      activeDevices: testing.activeDevices,
    },
  };
}

/**
 * Get readiness status (for Kubernetes readiness probe)
 * Returns true if application is ready to serve traffic
 */
export async function getReadiness(): Promise<boolean> {
  try {
    const health = await getHealthStatus();
    return health.status !== 'unhealthy' && health.database.status === 'connected';
  } catch (error) {
    logger.error({ error }, 'Readiness check failed');
    return false;
  }
}

/**
 * Get liveness status (for Kubernetes liveness probe)
 * Returns true if application is alive
 */
export async function getLiveness(): Promise<boolean> {
  try {
    // Basic check - just verify process is running
    return process.uptime() > 0;
  } catch (error) {
    logger.error({ error }, 'Liveness check failed');
    return false;
  }
}

