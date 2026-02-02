/**
 * Diagnostic script to check why only 2-4 requests per hour are happening
 * 
 * This script checks:
 * 1. How many proxies are marked as active
 * 2. How many proxies have recent requests
 * 3. What the actual request rate is
 * 4. Configuration values
 */

import { PrismaClient } from '@prisma/client';
import { config } from '../src/config';

const prisma = new PrismaClient();

async function diagnoseTestingIssues() {
  console.log('=== Continuous Testing Diagnostic ===\n');

  // 1. Check configuration
  console.log('1. Configuration:');
  console.log(`   TEST_INTERVAL_MS: ${config.testing.intervalMs}ms (${config.testing.intervalMs / 1000}s)`);
  console.log(`   Expected requests/hour: ${3600000 / config.testing.intervalMs}`);
  console.log(`   PROXY_REFRESH_INTERVAL_MS: ${config.refresh.intervalMs}ms (${config.refresh.intervalMs / 60000} minutes)\n`);

  // 2. Check proxy status
  const totalProxies = await prisma.proxy.count();
  const activeProxies = await prisma.proxy.count({
    where: { active: true },
  });
  const inactiveProxies = totalProxies - activeProxies;

  console.log('2. Proxy Status:');
  console.log(`   Total proxies: ${totalProxies}`);
  console.log(`   Active proxies: ${activeProxies}`);
  console.log(`   Inactive proxies: ${inactiveProxies}\n`);

  // 3. Check requests in last hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const requestsLastHour = await prisma.proxyRequest.count({
    where: {
      timestamp: {
        gte: oneHourAgo,
      },
    },
  });

  const requestsBySource = await prisma.proxyRequest.groupBy({
    by: ['source'],
    where: {
      timestamp: {
        gte: oneHourAgo,
      },
    },
    _count: {
      id: true,
    },
  });

  console.log('3. Requests in Last Hour:');
  console.log(`   Total requests: ${requestsLastHour}`);
  requestsBySource.forEach((group) => {
    console.log(`   ${group.source}: ${group._count.id}`);
  });
  console.log();

  // 4. Check requests per proxy in last hour
  const requestsPerProxy = await prisma.proxyRequest.groupBy({
    by: ['proxyId'],
    where: {
      timestamp: {
        gte: oneHourAgo,
      },
    },
    _count: {
      id: true,
    },
    orderBy: {
      _count: {
        id: 'desc',
      },
    },
    take: 20, // Top 20 proxies
  });

  console.log('4. Top 20 Proxies by Request Count (Last Hour):');
  for (const proxy of requestsPerProxy) {
    const proxyInfo = await prisma.proxy.findUnique({
      where: { deviceId: proxy.proxyId },
      select: { name: true, active: true, proxyStatus: true },
    });
    const expectedRequests = 3600000 / config.testing.intervalMs;
    const actualRequests = proxy._count.id;
    const percentage = (actualRequests / expectedRequests) * 100;
    
    console.log(
      `   ${proxy.proxyId.substring(0, 8)}... | ${proxyInfo?.name || 'Unknown'} | ` +
      `Active: ${proxyInfo?.active ? 'Yes' : 'No'} | ` +
      `Status: ${proxyInfo?.proxyStatus || 'N/A'} | ` +
      `Requests: ${actualRequests} (expected: ${expectedRequests.toFixed(0)}, ${percentage.toFixed(1)}%)`
    );
  }
  console.log();

  // 5. Check proxies with no requests in last hour
  const proxiesWithNoRequests = await prisma.proxy.findMany({
    where: {
      active: true,
      proxyRequests: {
        none: {
          timestamp: {
            gte: oneHourAgo,
          },
        },
      },
    },
    select: {
      deviceId: true,
      name: true,
      proxyStatus: true,
      lastIp: true,
    },
    take: 10,
  });

  if (proxiesWithNoRequests.length > 0) {
    console.log('5. Active Proxies with NO Requests in Last Hour (showing first 10):');
    proxiesWithNoRequests.forEach((proxy) => {
      console.log(
        `   ${proxy.deviceId.substring(0, 8)}... | ${proxy.name} | Status: ${proxy.proxyStatus || 'N/A'}`
      );
    });
    console.log();
  }

  // 6. Check recent rotation cycles
  const recentCycles = await prisma.rotationCycle.findMany({
    where: {
      createdAt: {
        gte: oneHourAgo,
      },
    },
    select: {
      id: true,
      cycleType: true,
      createdAt: true,
      _count: {
        ipRotations: true,
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: 5,
  });

  if (recentCycles.length > 0) {
    console.log('6. Recent Rotation Cycles (Last Hour):');
    recentCycles.forEach((cycle) => {
      console.log(
        `   ${cycle.id.substring(0, 8)}... | Type: ${cycle.cycleType} | ` +
        `Created: ${cycle.createdAt.toISOString()} | Rotations: ${cycle._count.ipRotations}`
      );
    });
    console.log();
  }

  // 7. Summary
  console.log('=== Summary ===');
  console.log(`Expected requests/hour per active proxy: ${3600000 / config.testing.intervalMs}`);
  console.log(`Active proxies: ${activeProxies}`);
  console.log(`Total requests in last hour: ${requestsLastHour}`);
  console.log(`Average requests per active proxy: ${activeProxies > 0 ? (requestsLastHour / activeProxies).toFixed(1) : 0}`);
  
  if (activeProxies > 0) {
    const expectedTotal = activeProxies * (3600000 / config.testing.intervalMs);
    const actualPercentage = (requestsLastHour / expectedTotal) * 100;
    console.log(`Expected total requests: ${expectedTotal.toFixed(0)}`);
    console.log(`Actual percentage: ${actualPercentage.toFixed(1)}%`);
    
    if (actualPercentage < 10) {
      console.log('\n⚠️  WARNING: Request rate is very low!');
      console.log('   Possible causes:');
      console.log('   1. Proxies are being marked inactive');
      console.log('   2. Testing loops are stopping prematurely');
      console.log('   3. Device refresh is not picking up active proxies');
      console.log('   4. TEST_INTERVAL_MS might not be applied correctly');
    }
  }
}

diagnoseTestingIssues()
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
