/**
 * Export verification data for a specific cycle ID to CSV
 * 
 * Usage: npx ts-node scripts/export-verification-data.ts <cycleId>
 */

import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();

async function exportVerificationData(cycleId: string) {
  try {
    // Get cycle information
    const cycle = await prisma.rotationCycle.findUnique({
      where: { id: cycleId },
      select: {
        id: true,
        cycleType: true,
        totalProxies: true,
        successfulCount: true,
        failedCount: true,
        pendingCount: true,
        status: true,
        cycleTimestamp: true,
      },
    });

    if (!cycle) {
      console.error(`Cycle ID ${cycleId} not found`);
      process.exit(1);
    }

    // Get max attempts from config (default 5)
    const maxAttempts = parseInt(process.env.ROTATION_MAX_VERIFICATION_ATTEMPTS || '5', 10);

    // Get all rotations for this cycle
    const rotations = await prisma.ipRotation.findMany({
      where: { cycleId },
      select: {
        id: true,
        proxyId: true,
        success: true,
        retryCount: true,
        waitTimeMs: true,
        verifiedAt: true,
        errorMessage: true,
        verificationMethod: true,
        rotationDurationMs: true,
      },
      orderBy: {
        proxyId: 'asc',
      },
    });

    if (rotations.length === 0) {
      console.error(`No rotations found for cycle ID ${cycleId}`);
      process.exit(1);
    }

    // Prepare CSV data
    const csvRows: string[] = [];
    
    // CSV Header
    csvRows.push('cycle_id,proxy_id,max_attempts,final_status,retry_count,wait_time_ms,verified_at,error_message,verification_method,rotation_duration_ms');

    // CSV Rows
    for (const rotation of rotations) {
      const finalStatus = rotation.success ? 'SUCCESS' : 'FAILED';
      const verifiedAt = rotation.verifiedAt ? rotation.verifiedAt.toISOString() : '';
      const errorMessage = rotation.errorMessage ? rotation.errorMessage.replace(/,/g, ';') : '';
      const verificationMethod = rotation.verificationMethod || '';
      const rotationDurationMs = rotation.rotationDurationMs || '';

      csvRows.push(
        [
          cycleId,
          rotation.proxyId,
          maxAttempts,
          finalStatus,
          rotation.retryCount,
          rotation.waitTimeMs || 0,
          verifiedAt,
          errorMessage,
          verificationMethod,
          rotationDurationMs,
        ].join(',')
      );
    }

    // Write to file
    const outputPath = join(process.cwd(), `verification-data-${cycleId}.csv`);
    writeFileSync(outputPath, csvRows.join('\n'), 'utf-8');

    console.log(`\n✅ Verification data exported successfully!`);
    console.log(`\nCycle Information:`);
    console.log(`  Cycle ID: ${cycleId}`);
    console.log(`  Cycle Type: ${cycle.cycleType}`);
    console.log(`  Total Proxies: ${cycle.totalProxies}`);
    console.log(`  Successful: ${cycle.successfulCount}`);
    console.log(`  Failed: ${cycle.failedCount}`);
    console.log(`  Pending: ${cycle.pendingCount}`);
    console.log(`  Status: ${cycle.status}`);
    console.log(`  Cycle Timestamp: ${cycle.cycleTimestamp.toISOString()}`);
    console.log(`\nTotal Rotations: ${rotations.length}`);
    console.log(`Max Attempts: ${maxAttempts}`);
    console.log(`\n📄 CSV file saved to: ${outputPath}\n`);

    // Print summary
    const successCount = rotations.filter((r) => r.success).length;
    const failedCount = rotations.filter((r) => !r.success).length;
    const avgRetryCount = rotations.reduce((sum, r) => sum + r.retryCount, 0) / rotations.length;
    const maxRetryCount = Math.max(...rotations.map((r) => r.retryCount));

    console.log(`\nSummary:`);
    console.log(`  Successful: ${successCount} (${((successCount / rotations.length) * 100).toFixed(2)}%)`);
    console.log(`  Failed: ${failedCount} (${((failedCount / rotations.length) * 100).toFixed(2)}%)`);
    console.log(`  Average Retry Count: ${avgRetryCount.toFixed(2)}`);
    console.log(`  Max Retry Count: ${maxRetryCount}`);
    console.log(`\n`);

  } catch (error) {
    console.error('Error exporting verification data:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Get cycle ID from command line argument
const cycleId = process.argv[2];

if (!cycleId) {
  console.error('Usage: npx ts-node scripts/export-verification-data.ts <cycleId>');
  console.error('Example: npx ts-node scripts/export-verification-data.ts 126590c0-ec73-4d56-bf40-8517caa907b6');
  process.exit(1);
}

exportVerificationData(cycleId);
