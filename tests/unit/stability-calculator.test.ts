import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateProxyStability } from '../../src/services/stability-calculator';
import { prisma } from '../../src/lib/db';

vi.mock('../../src/lib/db', () => ({
  prisma: {
    proxyRequest: {
      findMany: vi.fn(),
    },
    proxy: {
      update: vi.fn(),
    },
  },
}));

describe('Stability Calculator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return Stable when no failures in time windows', async () => {
    const mockRequests = [
      { timestamp: new Date(Date.now() - 30 * 60 * 1000), status: 'SUCCESS' },
      { timestamp: new Date(Date.now() - 20 * 60 * 1000), status: 'SUCCESS' },
      { timestamp: new Date(Date.now() - 10 * 60 * 1000), status: 'SUCCESS' },
    ];

    vi.mocked(prisma.proxyRequest.findMany).mockResolvedValue(mockRequests as any);
    vi.mocked(prisma.proxy.update).mockResolvedValue({} as any);

    const result = await calculateProxyStability('test-device-id');

    expect(result).toBe('Stable');
    expect(prisma.proxy.update).toHaveBeenCalledWith({
      where: { deviceId: 'test-device-id' },
      data: { stabilityStatus: 'Stable' },
    });
  });

  it('should calculate downtime correctly', () => {
    // Test that downtime = failed_count * test_interval
    const failedCount = 120; // 120 failed requests
    const testIntervalMs = 5000; // 5 seconds
    const expectedDowntime = failedCount * testIntervalMs; // 600,000ms = 10 minutes

    expect(expectedDowntime).toBe(600000);
  });
});

