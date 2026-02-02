
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- Debugging Proxy Requests & Rotations ---');

  // 1. Check recent Proxy Requests
  const recentRequests = await prisma.proxyRequest.findMany({
    take: 10,
    orderBy: { timestamp: 'desc' },
    select: {
      timestamp: true,
      status: true,
      errorType: true,
      outboundIp: true,
      proxyId: true,
    }
  });

  console.log('\nLast 10 Proxy Requests:');
  if (recentRequests.length === 0) {
    console.log('No requests found.');
  } else {
    console.table(recentRequests);
  }

  // 2. Check recent IP Rotations
  const recentRotations = await prisma.ipRotation.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      proxyId: true,
      success: true,
      ipBefore: true,
      ipAfter: true,
      statusBefore: true,
      statusAfter: true,
      errorMessage: true,
      createdAt: true,
    }
  });

  console.log('\nLast 5 IP Rotations:');
  if (recentRotations.length === 0) {
    console.log('No rotations found.');
  } else {
    console.table(recentRotations);
  }

  // 3. Check Proxy Statuses
  const proxyStats = await prisma.proxy.groupBy({
    by: ['active', 'proxyStatus'],
    _count: true,
  });
  console.log('\nProxy Status Distribution:');
  console.table(proxyStats);

}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
