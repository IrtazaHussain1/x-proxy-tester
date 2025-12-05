/**
 * HTTP Server Module
 * 
 * Lightweight HTTP server for health checks and metrics endpoints.
 * Exposes /health, /ready, /live, and /metrics endpoints.
 * 
 * @module server
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { getHealthStatus, getReadiness, getLiveness } from './api/health';
import { exportPrometheusMetrics } from './lib/metrics';
import { logger } from './lib/logger';

const PORT = parseInt(process.env.HEALTH_CHECK_PORT || '3000', 10);

/**
 * Handle HTTP requests
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    if (url === '/health' && method === 'GET') {
      const health = await getHealthStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health, null, 2));
    } else if (url === '/ready' && method === 'GET') {
      const ready = await getReadiness();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready }));
    } else if (url === '/live' && method === 'GET') {
      const alive = await getLiveness();
      res.writeHead(alive ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ alive }));
    } else if (url === '/metrics' && method === 'GET') {
      const metrics = exportPrometheusMetrics();
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(metrics);
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

/**
 * Start HTTP server
 */
export function startServer(): void {
  const server = createServer(handleRequest);

  server.listen(PORT, () => {
    logger.info(
      {
        port: PORT,
        endpoints: {
          health: `http://localhost:${PORT}/health`,
          readiness: `http://localhost:${PORT}/ready`,
          liveness: `http://localhost:${PORT}/live`,
          metrics: `http://localhost:${PORT}/metrics`,
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

