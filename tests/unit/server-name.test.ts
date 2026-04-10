import { describe, expect, it } from 'vitest';
import { computeServerLabelFromDeviceName } from '../../src/helpers/server-name';

describe('computeServerLabelFromDeviceName', () => {
  it('extracts S# from S# P## and S#P## and Montreal-style names', () => {
    expect(computeServerLabelFromDeviceName('S7 P37')).toBe('S7');
    expect(computeServerLabelFromDeviceName('S10P6')).toBe('S10');
    expect(computeServerLabelFromDeviceName('S10p6')).toBe('S10');
    expect(computeServerLabelFromDeviceName('S32_P22_montreal')).toBe('S32');
    expect(computeServerLabelFromDeviceName('s9_p30_Montreal')).toBe('S9');
    expect(computeServerLabelFromDeviceName('S35_P09_montreal')).toBe('S35');
    expect(computeServerLabelFromDeviceName('S17 p1')).toBe('S17');
  });

  it('returns UNKNOWN when there is no P-slot (e.g. typo S39 29)', () => {
    expect(computeServerLabelFromDeviceName('S39 29')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for OEM / phone model strings that do not start with rack id', () => {
    expect(computeServerLabelFromDeviceName('samsung_SM-G981NS48 P37')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('TCL_T781SPP')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('Google_Pixel_4a')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('Wingtech_TMRV075G')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('Reliance_Communications_R678L5')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('motorola_moto_g_pure')).toBe('UNKNOWN');
  });

  it('does not pick S# from inside a Samsung model string (must lead with S#)', () => {
    expect(computeServerLabelFromDeviceName('samsung_SM-G981NS8 P3')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('samsung_SM-S42 P25')).toBe('UNKNOWN');
  });

  it('strips leading port prefix', () => {
    expect(computeServerLabelFromDeviceName('port 3118 Reliance_Communications_R678L5')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for junk or incomplete rack tokens', () => {
    expect(computeServerLabelFromDeviceName('_Test_Simulator_jam')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('S16')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName(null)).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('   ')).toBe('UNKNOWN');
  });
});
