import { describe, expect, it } from 'vitest';
import {
  EMPTY_DUPLICATE_SNAPSHOT_LAST_IP,
  fingerprintDuplicateIpDetailRows,
  floorToFiveMinuteUtc,
  parseServerLabelsFromAllServersOnIp,
} from '../../src/services/duplicate-ip-snapshot';

describe('parseServerLabelsFromAllServersOnIp', () => {
  it('splits comma-separated labels and trims spaces', () => {
    expect(parseServerLabelsFromAllServersOnIp('S23, S41')).toEqual(['S23', 'S41']);
    expect(parseServerLabelsFromAllServersOnIp('S41 ')).toEqual(['S41']);
  });

  it('returns Unknown as a single label', () => {
    expect(parseServerLabelsFromAllServersOnIp('Unknown')).toEqual(['Unknown']);
  });

  it('dedupes identical labels', () => {
    expect(parseServerLabelsFromAllServersOnIp('S10, S10')).toEqual(['S10']);
  });
});

describe('floorToFiveMinuteUtc', () => {
  it('floors to 5-minute boundary in UTC', () => {
    const d = new Date('2026-03-28T11:32:26.789Z');
    const f = floorToFiveMinuteUtc(d);
    expect(f.toISOString()).toBe('2026-03-28T11:30:00.000Z');
  });
});

describe('fingerprintDuplicateIpDetailRows', () => {
  it('is stable for same rows in different order', () => {
    const a = fingerprintDuplicateIpDetailRows([
      {
        last_ip: '1.1.1.1',
        location: 'A',
        all_servers_on_ip: 'S1, S2',
        phones_on_same_ip: 2,
        sibling_phones: 'p1 | p2',
        phone_names: null,
        device_ids: 'a|b',
      },
      {
        last_ip: '2.2.2.2',
        location: 'B',
        all_servers_on_ip: 'S3',
        phones_on_same_ip: 2,
        sibling_phones: 'p3 | p4',
        phone_names: null,
        device_ids: 'c|d',
      },
    ]);
    const b = fingerprintDuplicateIpDetailRows([
      {
        last_ip: '2.2.2.2',
        location: 'B',
        all_servers_on_ip: 'S3',
        phones_on_same_ip: 2,
        sibling_phones: 'p3 | p4',
        phone_names: null,
        device_ids: 'c|d',
      },
      {
        last_ip: '1.1.1.1',
        location: 'A',
        all_servers_on_ip: 'S1, S2',
        phones_on_same_ip: 2,
        sibling_phones: 'p1 | p2',
        phone_names: null,
        device_ids: 'a|b',
      },
    ]);
    expect(a).toBe(b);
  });

  it('exposes empty snapshot sentinel constant', () => {
    expect(EMPTY_DUPLICATE_SNAPSHOT_LAST_IP).toBe('__snapshot_empty__');
  });
});
