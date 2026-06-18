/**
 * Analytics API Handlers
 *
 * Provides endpoints for operational analytics:
 * - Problem phones: real-time list of phones with active issues
 */

import { prisma } from '../lib/db';
import { logger } from '../lib/logger';

interface ProblemPhone {
  deviceId: string;
  name: string;
  server: string | null;
  location: string | null;
  issues: string[];
  lastSeenAt: string | null;
  uptimePct1h: number | null;
  sameIpCount: number;
  stabilityStatus: string;
  rotationStatus: string | null;
  currentIp: string | null;
}

interface RecentStat {
  proxy_id: string;
  last_seen: Date | null;
  total_1h: bigint;
  success_1h: bigint;
}

const OFFLINE_THRESHOLD_MS = 15 * 60 * 1000;   // 15 minutes
const LOW_UPTIME_THRESHOLD = 90;                 // below 90% = problem
const STUCK_IP_SAME_COUNT = 10;                  // same_ip_count >= 10 = stuck

// ---------------------------------------------------------------------------
// TTL cache — the underlying data changes at most every 5 minutes (stability
// calc) so a 60-second TTL removes redundant raw-table scans while keeping
// the response acceptably fresh.
// ---------------------------------------------------------------------------

interface CachedResult {
  data: object;
  expiresAt: number;
}

let problemsCache: CachedResult | null = null;
const PROBLEMS_CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * GET /api/analytics/problems
 *
 * Returns active phones that have at least one of:
 *   - offline: no successful request in the last 15 minutes
 *   - low_uptime: success rate < 90% in the last hour
 *   - stuck_ip: rotation_status=NoRotation AND same_ip_count >= 10
 *   - unstable: stability_status is UnstableHourly or UnstableDaily
 *     (only flagged if not already captured by offline/low_uptime)
 *
 * Results are cached for 60 seconds. The `generatedAt` field in the response
 * reflects the time the data was computed (not the time of the HTTP request).
 *
 * `recentStats` is served from proxy_requests_5min_summary to avoid scanning
 * raw proxy_requests on every call. `last_seen` is approximated as
 * window_start + 5 min, so the effective offline detection window is
 * ~20 min rather than exactly 15 min — acceptable given the 60s cache TTL.
 */
export async function getProblemsHandler(): Promise<object> {
  // Return cached result if still fresh
  if (problemsCache && Date.now() < problemsCache.expiresAt) {
    return problemsCache.data;
  }

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const offlineThreshold = new Date(now.getTime() - OFFLINE_THRESHOLD_MS);

  try {
    const [proxies, recentStats] = await Promise.all([
      prisma.proxy.findMany({
        where: { active: true },
        select: {
          deviceId: true,
          name: true,
          relayServerId: true,
          location: true,
          sameIpCount: true,
          stabilityStatus: true,
          rotationStatus: true,
          ipAddress: true,
        },
      }),

      // Read from the 5-min summary instead of scanning raw proxy_requests.
      // last_seen = MAX(window_start) + 5 min (the window covers up to that point).
      prisma.$queryRaw<RecentStat[]>`
        SELECT
          proxy_id,
          DATE_ADD(MAX(window_start), INTERVAL 5 MINUTE) AS last_seen,
          SUM(total_requests)                             AS total_1h,
          SUM(success_count)                              AS success_1h
        FROM proxy_requests_5min_summary
        WHERE window_start >= ${oneHourAgo}
        GROUP BY proxy_id
      `,
    ]);

    const statsMap = new Map(recentStats.map((s) => [s.proxy_id, s]));

    const problems: ProblemPhone[] = [];

    for (const proxy of proxies) {
      const stats = statsMap.get(proxy.deviceId);
      const issues: string[] = [];

      // --- offline check ---
      const lastSeen = stats?.last_seen ?? null;
      const isOffline = !lastSeen || lastSeen < offlineThreshold;
      if (isOffline) issues.push('offline');

      // --- low uptime check (skip if already offline) ---
      let uptimePct: number | null = null;
      if (stats && Number(stats.total_1h) > 0) {
        uptimePct = (Number(stats.success_1h) / Number(stats.total_1h)) * 100;
        if (!isOffline && uptimePct < LOW_UPTIME_THRESHOLD) {
          issues.push('low_uptime');
        }
      }

      // --- stuck IP check ---
      if (
        proxy.sameIpCount >= STUCK_IP_SAME_COUNT &&
        proxy.rotationStatus === 'NoRotation'
      ) {
        issues.push('stuck_ip');
      }

      // --- unstable check (only if not already flagged for connectivity issues) ---
      if (
        !isOffline &&
        !issues.includes('low_uptime') &&
        (proxy.stabilityStatus === 'UnstableHourly' ||
          proxy.stabilityStatus === 'UnstableDaily')
      ) {
        issues.push('unstable');
      }

      if (issues.length > 0) {
        problems.push({
          deviceId: proxy.deviceId,
          name: proxy.name,
          server: proxy.relayServerId != null ? String(proxy.relayServerId) : null,
          location: proxy.location,
          issues,
          lastSeenAt: lastSeen?.toISOString() ?? null,
          uptimePct1h:
            uptimePct !== null ? Math.round(uptimePct * 100) / 100 : null,
          sameIpCount: proxy.sameIpCount,
          stabilityStatus: proxy.stabilityStatus,
          rotationStatus: proxy.rotationStatus,
          currentIp: proxy.ipAddress,
        });
      }
    }

    // Sort by severity: offline → low_uptime → stuck_ip → unstable
    const severityOrder = ['offline', 'low_uptime', 'stuck_ip', 'unstable'];
    problems.sort((a, b) => {
      const aSeverity = Math.min(
        ...a.issues.map((i) => severityOrder.indexOf(i))
      );
      const bSeverity = Math.min(
        ...b.issues.map((i) => severityOrder.indexOf(i))
      );
      return aSeverity - bSeverity;
    });

    const result = {
      generatedAt: now.toISOString(),
      summary: {
        totalProblems: problems.length,
        offline: problems.filter((p) => p.issues.includes('offline')).length,
        lowUptime: problems.filter((p) => p.issues.includes('low_uptime')).length,
        stuckIp: problems.filter((p) => p.issues.includes('stuck_ip')).length,
        unstable: problems.filter((p) => p.issues.includes('unstable')).length,
      },
      problems,
    };

    problemsCache = { data: result, expiresAt: Date.now() + PROBLEMS_CACHE_TTL_MS };
    return result;
  } catch (error) {
    logger.error({ error }, 'Failed to fetch problem phones');
    throw error;
  }
}
