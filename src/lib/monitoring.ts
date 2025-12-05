/**
 * Monitoring Integration Module
 * 
 * Provides integration points for external monitoring systems.
 * Supports Prometheus, custom metrics, and alerting hooks.
 * 
 * @module lib/monitoring
 */

import { logger } from './logger';
import { getMetrics, getSuccessRate, getAverageResponseTime } from './metrics';
import { getHealthStatus } from '../api/health';

/**
 * Alert severity levels
 */
export type AlertSeverity = 'critical' | 'warning' | 'info';

/**
 * Alert interface
 */
export interface Alert {
  severity: AlertSeverity;
  title: string;
  message: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

/**
 * Alert handler function type
 */
export type AlertHandler = (alert: Alert) => Promise<void> | void;

/**
 * Registered alert handlers
 */
const alertHandlers: AlertHandler[] = [];

/**
 * Register an alert handler
 */
export function registerAlertHandler(handler: AlertHandler): void {
  alertHandlers.push(handler);
}

/**
 * Send alert to all registered handlers
 */
export async function sendAlert(alert: Alert): Promise<void> {
  logger.warn(alert, `Alert: ${alert.title}`);
  
  for (const handler of alertHandlers) {
    try {
      await handler(alert);
    } catch (error) {
      logger.error({ error, alert }, 'Alert handler failed');
    }
  }
}

/**
 * Check conditions and send alerts
 */
export async function checkAlerts(): Promise<void> {
  const health = await getHealthStatus();
  const metrics = getMetrics();
  const successRate = getSuccessRate();
  const avgResponseTime = getAverageResponseTime();

  // Critical: Database disconnected
  if (health.database.status !== 'connected') {
    await sendAlert({
      severity: 'critical',
      title: 'Database Disconnected',
      message: 'Database connection is down',
      timestamp: new Date(),
      metadata: {
        databaseStatus: health.database.status,
      },
    });
  }

  // Critical: High error rate
  if (metrics.totalRequests > 100 && successRate < 50) {
    await sendAlert({
      severity: 'critical',
      title: 'High Error Rate',
      message: `Success rate is ${successRate.toFixed(2)}% (below 50% threshold)`,
      timestamp: new Date(),
      metadata: {
        successRate,
        totalRequests: metrics.totalRequests,
        failedRequests: metrics.failedRequests,
      },
    });
  }

  // Warning: Low success rate
  if (metrics.totalRequests > 100 && successRate < 90) {
    await sendAlert({
      severity: 'warning',
      title: 'Low Success Rate',
      message: `Success rate is ${successRate.toFixed(2)}% (below 90% threshold)`,
      timestamp: new Date(),
      metadata: {
        successRate,
        totalRequests: metrics.totalRequests,
      },
    });
  }

  // Warning: High memory usage
  if (health.system.memory.percentage > 80) {
    await sendAlert({
      severity: 'warning',
      title: 'High Memory Usage',
      message: `Memory usage is ${health.system.memory.percentage.toFixed(2)}%`,
      timestamp: new Date(),
      metadata: {
        memoryUsed: health.system.memory.used,
        memoryTotal: health.system.memory.total,
        percentage: health.system.memory.percentage,
      },
    });
  }

  // Warning: No active proxies
  if (health.testing.activeDevices === 0 && health.uptime > 300) {
    // Only alert if uptime > 5 minutes (to avoid false positives on startup)
    await sendAlert({
      severity: 'warning',
      title: 'No Active Proxies',
      message: 'No proxies are currently being tested',
      timestamp: new Date(),
      metadata: {
        activeDevices: health.testing.activeDevices,
        isRunning: health.testing.isRunning,
      },
    });
  }

  // Warning: Slow response times
  if (avgResponseTime > 5000 && metrics.totalRequests > 100) {
    await sendAlert({
      severity: 'warning',
      title: 'Slow Response Times',
      message: `Average response time is ${avgResponseTime.toFixed(0)}ms (above 5000ms threshold)`,
      timestamp: new Date(),
      metadata: {
        averageResponseTime: avgResponseTime,
        totalRequests: metrics.totalRequests,
      },
    });
  }
}

/**
 * Start periodic alert checking
 */
export function startAlertMonitoring(intervalMs: number = 60000): NodeJS.Timeout {
  logger.info({ intervalMs }, 'Starting alert monitoring');

  // Check immediately
  void checkAlerts();

  // Then check periodically
  const interval = setInterval(() => {
    void checkAlerts();
  }, intervalMs);

  return interval;
}

/**
 * Example alert handlers
 */

/**
 * Console alert handler (for development)
 */
export function consoleAlertHandler(alert: Alert): void {
  const emoji = {
    critical: '🔴',
    warning: '🟡',
    info: '🔵',
  }[alert.severity];

  console.error(
    `${emoji} [${alert.severity.toUpperCase()}] ${alert.title}: ${alert.message}`,
    alert.metadata
  );
}

/**
 * HTTP webhook alert handler
 */
export function createWebhookAlertHandler(url: string): AlertHandler {
  return async (alert: Alert) => {
    try {
      // Use undici for fetch in Node.js
      const { request } = await import('undici');
      const response = await request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(alert),
      });

      if (response.statusCode && response.statusCode >= 400) {
        throw new Error(`Webhook returned ${response.statusCode}`);
      }
    } catch (error) {
      logger.error({ error, url }, 'Webhook alert handler failed');
      throw error;
    }
  };
}

/**
 * Slack webhook alert handler
 */
export function createSlackAlertHandler(webhookUrl: string): AlertHandler {
  return async (alert: Alert) => {
    try {
      const color = {
        critical: '#ff0000',
        warning: '#ffaa00',
        info: '#0066cc',
      }[alert.severity];

      const payload = {
        attachments: [
          {
            color,
            title: alert.title,
            text: alert.message,
            fields: Object.entries(alert.metadata || {}).map(([key, value]) => ({
              title: key,
              value: String(value),
              short: true,
            })),
            footer: 'XProxy Tester',
            ts: Math.floor(alert.timestamp.getTime() / 1000),
          },
        ],
      };

      // Use undici for fetch in Node.js
      const { request } = await import('undici');
      const response = await request(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.statusCode && response.statusCode >= 400) {
        throw new Error(`Slack webhook returned ${response.statusCode}`);
      }
    } catch (error) {
      logger.error({ error }, 'Slack alert handler failed');
      throw error;
    }
  };
}

