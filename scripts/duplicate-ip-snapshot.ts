/**
 * CLI: run Cross-Server Duplicate IP snapshots once, or prune old runs only.
 *
 * Usage:
 *   npx tsx scripts/duplicate-ip-snapshot.ts
 *   npx tsx scripts/duplicate-ip-snapshot.ts --prune-only
 */

import 'dotenv/config';
import {
  pruneDuplicateIpSnapshotsOlderThanDays,
  runDuplicateIpSnapshots,
} from '../src/services/duplicate-ip-snapshot';
import { logger } from '../src/lib/logger';

const pruneOnly = process.argv.includes('--prune-only');
const retentionDays = parseInt(process.env.DUPLICATE_IP_SNAPSHOT_RETENTION_DAYS || '90', 10);

async function main(): Promise<void> {
  if (pruneOnly) {
    const deleted = await pruneDuplicateIpSnapshotsOlderThanDays(retentionDays);
    logger.info({ ok: true, deletedRuns: deleted, retentionDays }, 'duplicate-ip-snapshot prune-only');
    return;
  }
  await runDuplicateIpSnapshots({ retentionDays });
  logger.info({ ok: true }, 'duplicate-ip-snapshot run completed');
}

main().catch((e) => {
  logger.error({ err: e instanceof Error ? e.message : e }, 'duplicate-ip-snapshot failed');
  process.exit(1);
});
