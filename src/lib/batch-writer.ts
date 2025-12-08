/**
 * Batch Writer Module
 * 
 * NOTE: Currently unused - kept for future performance optimization.
 * Provides batching functionality for database writes to improve performance.
 * Accumulates writes and flushes them in batches.
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

      // Execute in transaction
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Create proxies
        for (const item of proxyCreates) {
          await tx.proxy.create({ data: item.data });
        }

        // Update proxies
        for (const item of proxyUpdates) {
          await tx.proxy.update({ where: item.where, data: item.data });
        }

        // Create requests in batch
        if (requestCreates.length > 0) {
          await tx.proxyRequest.createMany({
            data: requestCreates.map((item) => item.data),
            skipDuplicates: true,
          });
        }
      });

      logger.debug(
        {
          proxyCreates: proxyCreates.length,
          proxyUpdates: proxyUpdates.length,
          requestCreates: requestCreates.length,
        },
        'Batch write completed'
      );
    } catch (error) {
      logger.error({ error, batchSize: items.length }, 'Batch write failed');
      // Re-add items to batch for retry (optional - could also drop them)
      // this.batch.unshift(...items);
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

// Create singleton instance
// Note: For now, we'll use direct writes. Batch writer can be enabled later if needed.
// export const batchWriter = new BatchWriter(100, 5000);

