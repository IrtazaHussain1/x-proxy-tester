import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

const prisma = new PrismaClient({
  log: [
    { level: 'error', emit: 'event' },
    { level: 'warn', emit: 'event' },
  ],
});

prisma.$on('error', (e: any) => {
  logger.error({ error: e }, 'Prisma error');
});

prisma.$on('warn', (e: any) => {
  logger.warn({ warning: e }, 'Prisma warning');
});

// Ensure the Prisma client disconnects when the process exits
process.on('beforeExit', async () => {
  await prisma.$disconnect();
  logger.info('Prisma client disconnected');
});

export { prisma };

