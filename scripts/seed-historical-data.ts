import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import readline from 'readline';
import { aggregateDailySummary } from '../src/services/daily-aggregation';
import { archiveOldRequests } from '../src/services/archival';

// Utility script to backfill historical proxy_requests data for testing
// daily aggregation and archival logic.

type SeedOptions = {
  days: number;
  startDaysAgo: number;
  requestsPerDay: number;
  proxyCount: number;
  seedTag: string;
  runAggregation: boolean;
  runArchival: boolean;
  retentionDays?: number;
  reset: boolean;
};

let prisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

function getArgValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) {
    return direct.substring(prefix.length);
  }

  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }

  return undefined;
}

function getNumberArg(name: string, defaultValue: number): number {
  const raw = getArgValue(name);
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function getStringArg(name: string, defaultValue: string): string {
  return getArgValue(name) ?? defaultValue;
}

function getFlag(name: string): boolean {
  const raw = getArgValue(name);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return process.argv.includes(`--${name}`);
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function startOfUtcDay(daysAgo: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

function getDbInfo() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL is not set');
  }

  const url = new URL(dbUrl);
  return {
    url,
    host: url.hostname,
    port: url.port || '(default)',
    database: url.pathname.replace(/^\//, '') || '(none)',
    user: url.username || '(none)',
    protocol: url.protocol.replace(':', ''),
  };
}

async function confirmDatabaseTarget(): Promise<void> {
  const info = getDbInfo();
  console.log('Target database:');
  console.log(`  protocol: ${info.protocol}`);
  console.log(`  host:     ${info.host}`);
  console.log(`  port:     ${info.port}`);
  console.log(`  database: ${info.database}`);
  console.log(`  user:     ${info.user}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer: string = await new Promise((resolve) => {
    rl.question('Proceed with seeding? (y/N): ', (res) => resolve(res.trim()));
  });
  rl.close();
  console.log('answer', answer);
  if (answer.toLowerCase() !== 'y') {
    throw new Error('Aborted by user');
  }
}

function buildSeedOptions(): SeedOptions {
  const days = getNumberArg('days', 45);
  return {
    days,
    startDaysAgo: getNumberArg('start-days-ago', 1),
    requestsPerDay: getNumberArg('requests', 120),
    proxyCount: getNumberArg('proxies', 3),
    seedTag: getStringArg('tag', 'seed_historical'),
    runAggregation: true,
    runArchival: true,
    retentionDays: getNumberArg('retention-days', 14),
    reset: getFlag('reset'),
  };
}

async function ensureSeedProxies(proxyCount: number, seedTag: string) {
  const proxies: Array<{ deviceId: string }> = [];

  for (let i = 0; i < proxyCount; i++) {
    const deviceId = `${seedTag}-proxy-${i + 1}`;
    const location =
      i % 3 === 0 ? 'San Francisco, US' : i % 3 === 1 ? 'New York, US' : 'London, UK';

    await getPrisma().proxy.upsert({
      where: { deviceId },
      update: {
        name: `Seed Proxy ${i + 1}`,
        host: `10.0.${i + 1}.1`,
        port: 8000 + i,
        location,
        active: true,
      },
      create: {
        deviceId,
        name: `Seed Proxy ${i + 1}`,
        host: `10.0.${i + 1}.1`,
        port: 8000 + i,
        location,
        protocol: 'http',
        active: true,
      },
    });

    proxies.push({ deviceId });
  }

  return proxies;
}

function buildRequestsForDay(
  proxyId: string,
  dayStart: Date,
  requestsPerDay: number,
  seedTag: string,
  dayOffset: number
): Prisma.ProxyRequestCreateManyInput[] {
  const statuses = ['SUCCESS', 'SUCCESS', 'SUCCESS', 'HTTP_ERROR', 'TIMEOUT', 'CONNECTION_ERROR', 'DNS_ERROR'] as const;
  const records: Prisma.ProxyRequestCreateManyInput[] = [];

  for (let i = 0; i < requestsPerDay; i++) {
    const status = statuses[(i + dayOffset) % statuses.length];
    const isSuccess = status === 'SUCCESS';
    const timestamp = new Date(dayStart.getTime() + randomInt(0, 86_399_000));
    const ipOctet = 50 + dayOffset;
    const outboundIp = `10.${ipOctet}.${(i % 250) + 1}.${(i % 200) + 1}`;
    const ipChanged = i % 12 === 0;

    const errorType = isSuccess
      ? null
      : status === 'TIMEOUT'
        ? 'TIMEOUT'
        : status === 'HTTP_ERROR'
          ? 'HTTP_ERROR'
          : status === 'DNS_ERROR'
            ? 'DNS_ERROR'
            : 'CONNECTION_RESET';

    const record = {
      id: randomUUID(),
      proxyId,
      timestamp,
      targetUrl: `https://example.com/test-${(i % 5) + 1}`,
      status,
      httpStatusCode: isSuccess ? 200 : 500,
      responseTimeMs: isSuccess ? randomInt(80, 950) : randomInt(800, 4500),
      expectedIp: `10.${ipOctet}.0.1`,
      outboundIp,
      ipChanged,
      errorType,
      errorMessage: isSuccess ? null : `${status} simulated for seed data`,
      source: seedTag,
      downloadSpeedMbps: isSuccess ? randomInt(20, 120) : null,
      uploadSpeedMbps: isSuccess ? randomInt(5, 60) : null,
    } as Prisma.ProxyRequestCreateManyInput;

    records.push(record);
  }

  return records;
}

async function resetSeedData(seedTag: string, proxyIds: string[]) {
  console.log(`Reset requested - removing existing seed data tagged "${seedTag}"`);
  const client = getPrisma();

  await client.proxyRequest.deleteMany({
    where: {
      OR: [{ source: seedTag }, { proxyId: { in: proxyIds } }],
    },
  });

  await client.$executeRawUnsafe(
    `DELETE FROM proxy_requests_daily_summary WHERE proxy_id IN (${proxyIds.map(() => '?').join(',')})`,
    ...proxyIds
  );

  await client.proxy.deleteMany({
    where: {
      deviceId: { in: proxyIds },
    },
  });
}

async function main() {
  const options = buildSeedOptions();
  const seededDates: Date[] = [];

  await confirmDatabaseTarget();

  if (options.days < 1) {
    throw new Error('days must be at least 1');
  }
  if (options.proxyCount < 1) {
    throw new Error('proxies must be at least 1');
  }
  if (options.requestsPerDay < 1) {
    throw new Error('requests per day must be at least 1');
  }
  if (options.retentionDays !== undefined && options.retentionDays < 1) {
    throw new Error('retention-days must be at least 1 when provided');
  }

  console.log('Seeding historical data with options:', options);

  if (options.reset) {
    const proxyIds = Array.from({ length: options.proxyCount }).map(
      (_, i) => `${options.seedTag}-proxy-${i + 1}`
    );
    await resetSeedData(options.seedTag, proxyIds);
  }

  // const proxies = await ensureSeedProxies(options.proxyCount, options.seedTag);
  // const proxyIds = proxies.map((p) => p.deviceId);

  // for (let i = 0; i < options.days; i++) {
  //   const dayOffset = options.startDaysAgo + i;
  //   const dayStart = startOfUtcDay(dayOffset);
  //   seededDates.push(dayStart);

  //   for (const proxy of proxies) {
  //     const records = buildRequestsForDay(
  //       proxy.deviceId,
  //       dayStart,
  //       options.requestsPerDay,
  //       options.seedTag,
  //       dayOffset
  //     );

  //     await getPrisma().proxyRequest.createMany({
  //       data: records,
  //     });
  //   }

  //   if ((i + 1) % 5 === 0 || i === options.days - 1) {
  //     console.log(`Inserted day ${i + 1}/${options.days} (offset ${dayOffset} days ago)`);
  //   }
  // }

  if (options.runAggregation) {
    console.log('Running daily aggregation for seeded days...');
    for (const day of seededDates) {
      await aggregateDailySummary(day);
    }
  }

  if (options.runArchival) {
    console.log('Running archival after seeding...');
    await archiveOldRequests(options.retentionDays);
  }

  console.log('Seeding complete.');
}

main()
  .catch((error) => {
    console.error('Seeding failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (prisma) {
      await prisma.$disconnect();
      process.exit();
    }
  });

