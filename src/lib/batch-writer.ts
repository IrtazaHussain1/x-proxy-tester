/**
 * Batch Writer Module
 * 
 * Provides batching functionality for database writes to improve performance.
 * Accumulates writes and flushes them in batches to reduce database overhead.
 * Optimized for high-volume writes (~2.85M records/day).
 */

import { Prisma } from '@prisma/client';
import { logger } from './logger';
import { prismaWithRetry as prisma } from './db';

interface BatchItem {
  type: 'create' | 'update';
  model: 'proxy' | 'proxyRequest';
  data: any;
  where?: any;
}

class BatchWriter {
  private batch: BatchItem[] = [];
  private batchSize: number;
  private flushInterval: NodeJS.Timeout | null = null;
  private flushIntervalMs: number;

  constructor(batchSize: number = 100, flushIntervalMs: number = 5000) {
    this.batchSize = batchSize;
    this.flushIntervalMs = flushIntervalMs;
  }

  add(item: BatchItem): void {
    this.batch.push(item);

    // Flush if batch size reached
    if (this.batch.length >= this.batchSize) {
      void this.flush();
    }

    // Start flush interval if not already started
    if (!this.flushInterval && this.batch.length > 0) {
      this.flushInterval = setInterval(() => {
        void this.flush();
      }, this.flushIntervalMs);
    }
  }

  async flush(): Promise<void> {
    if (this.batch.length === 0) {
      return;
    }

    const items = [...this.batch];
    this.batch = [];

    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    try {
      // Group by model and type
      const proxyCreates = items.filter((i) => i.model === 'proxy' && i.type === 'create');
      const proxyUpdates = items.filter((i) => i.model === 'proxy' && i.type === 'update');
      const requestCreates = items.filter((i) => i.model === 'proxyRequest' && i.type === 'create');
      const requestCreateChunkSize = parseInt(process.env.PROXY_REQUEST_BATCH_WRITE_CHUNK_SIZE || '200', 10);

      // Keep lock-heavy request bulk inserts out of interactive transactions.
      // This shortens lock hold times and avoids transaction-level contention escalation.
      if (proxyCreates.length > 0 || proxyUpdates.length > 0) {
        await prisma.$transaction(
          async (tx: Prisma.TransactionClient) => {
            // Create proxies
            for (const item of proxyCreates) {
              await tx.proxy.create({ data: item.data });
            }

            // Update proxies
            for (const item of proxyUpdates) {
              await tx.proxy.update({ where: item.where, data: item.data });
            }
          },
          { maxWait: 20_000, timeout: 120_000 }
        );
      }

      if (requestCreates.length > 0) {
        const safeChunkSize = !isNaN(requestCreateChunkSize) && requestCreateChunkSize > 0
          ? requestCreateChunkSize
          : 200;
        for (let i = 0; i < requestCreates.length; i += safeChunkSize) {
          const chunk = requestCreates.slice(i, i + safeChunkSize);
          await prisma.proxyRequest.createMany({
            data: chunk.map((item) => item.data),
            skipDuplicates: true,
          });
        }
      }

      logger.debug(
        {
          proxyCreates: proxyCreates.length,
          proxyUpdates: proxyUpdates.length,
          requestCreates: requestCreates.length,
        },
        'Batch write completed'
      );
    } catch (error) {
      logger.error({ error, batchSize: items.length }, 'Batch write failed, re-queuing items');
      this.batch = [...items, ...this.batch];
    }
  }

  async forceFlush(): Promise<void> {
    await this.flush();
  }

  getBatchSize(): number {
    return this.batch.length;
  }
}

// Export BatchWriter class for potential future use
export { BatchWriter };

// Create singleton instance for batch writing
// Batch size: 500 records (optimized for ~2.85M records/day)
// Flush interval: 2 seconds (balance between latency and throughput)
export const batchWriter = new BatchWriter(500, 2000);

