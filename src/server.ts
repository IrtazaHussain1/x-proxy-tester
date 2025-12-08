/**
 * HTTP Server Module
 * Lightweight HTTP server for health checks and metrics endpoints.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { getHealthStatus, getReadiness, getLiveness } from './api/health';
import { exportPrometheusMetrics } from './lib/metrics';
import { logger } from './lib/logger';
import {
  getTestingStatusHandler,
  startTestingHandler,
  stopTestingHandler,
} from './api/testing';

const PORT = parseInt(process.env.HEALTH_CHECK_PORT || '3000', 10);

// Handle incoming HTTP requests and route to appropriate handlers
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // Set CORS headers to allow cross-origin requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle CORS preflight requests
  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    // Health check endpoint - returns overall application health status
    if (url === '/health' && method === 'GET') {
      const health = await getHealthStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health, null, 2));
    // Readiness probe - checks if app is ready to accept traffic
    } else if (url === '/ready' && method === 'GET') {
      const ready = await getReadiness();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready }));
    // Liveness probe - checks if app is still running
    } else if (url === '/live' && method === 'GET') {
      const alive = await getLiveness();
      res.writeHead(alive ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ alive }));
    // Prometheus metrics endpoint - exports metrics in Prometheus format
    } else if (url === '/metrics' && method === 'GET') {
      const metrics = exportPrometheusMetrics();
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(metrics);
    // Get current testing status (running/stopped, active devices count)
    } else if (url === '/api/testing/status' && method === 'GET') {
      const status = await getTestingStatusHandler();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status, null, 2));
    // Start proxy testing via API
    } else if (url === '/api/testing/start' && method === 'POST') {
      const result = await startTestingHandler();
      res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result, null, 2));
    // Stop proxy testing via API
    } else if (url === '/api/testing/stop' && method === 'POST') {
      const result = await stopTestingHandler();
      res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result, null, 2));
    // Root endpoint - returns API documentation with available endpoints
    } else if (url === '/' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          service: 'x-proxy-tester',
          version: '1.0.0',
          endpoints: {
            health: '/health',
            readiness: '/ready',
            liveness: '/live',
            metrics: '/metrics',
            testing: {
              status: 'GET /api/testing/status',
              start: 'POST /api/testing/start',
              stop: 'POST /api/testing/stop',
            },
          },
        })
      );
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (error) {
    logger.error({ error, url, method }, 'Error handling HTTP request');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

// Start the HTTP server for health checks and metrics
export function startServer(): void {
  const server = createServer(handleRequest);

  // Listen on configured port and log available endpoints
  server.listen(PORT, () => {
    logger.info(
      {
        port: PORT,
        endpoints: {
          health: `http://localhost:${PORT}/health`,
          readiness: `http://localhost:${PORT}/ready`,
          liveness: `http://localhost:${PORT}/live`,
          metrics: `http://localhost:${PORT}/metrics`,
          testing: {
            status: `http://localhost:${PORT}/api/testing/status`,
            start: `http://localhost:${PORT}/api/testing/start`,
            stop: `http://localhost:${PORT}/api/testing/stop`,
          },
        },
      },
      'Health check server started'
    );
  });

  server.on('error', (error) => {
    logger.error({ error, port: PORT }, 'Health check server error');
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('Shutting down health check server');
    server.close(() => {
      logger.info('Health check server closed');
    });
  });
}

