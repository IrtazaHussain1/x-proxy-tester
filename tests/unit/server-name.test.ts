import { describe, expect, it } from 'vitest';
import { computeServerLabelFromDeviceName } from '../../src/helpers/server-name';

describe('computeServerLabelFromDeviceName', () => {
  it('extracts S# from clean S# P## and S#P## and Montreal-style names', () => {
    expect(computeServerLabelFromDeviceName('S7 P37')).toBe('S7');
    expect(computeServerLabelFromDeviceName('S10P6')).toBe('S10');
    expect(computeServerLabelFromDeviceName('S10p6')).toBe('S10');
    expect(computeServerLabelFromDeviceName('S32_P22_montreal')).toBe('S32');
    expect(computeServerLabelFromDeviceName('s9_p30_Montreal')).toBe('S9');
    expect(computeServerLabelFromDeviceName('S35_P09_montreal')).toBe('S35');
    expect(computeServerLabelFromDeviceName('S17 p1')).toBe('S17');
    expect(computeServerLabelFromDeviceName('S213 P1')).toBe('S213');
  });

  it('recovers the rack token when it is glued onto a phone model (P## suffix present)', () => {
    expect(computeServerLabelFromDeviceName('samsung_SM-G981BS37 P22')).toBe('S37');
    expect(computeServerLabelFromDeviceName('samsung_SM-G981NS37 P14')).toBe('S37');
    expect(computeServerLabelFromDeviceName('samsung_SM-G981NS48 P37')).toBe('S48');
    expect(computeServerLabelFromDeviceName('samsung_SM-G981NS8 P11')).toBe('S8');
    expect(computeServerLabelFromDeviceName('samsung_SM-G981NS8 P3')).toBe('S8');
    expect(computeServerLabelFromDeviceName('samsung_SM-S42 P25')).toBe('S42');
  });

  it('recovers a leading rack token that dropped its P (e.g. typo S39 29)', () => {
    expect(computeServerLabelFromDeviceName('S39 29')).toBe('S39');
  });

  it('does NOT mistake a model number for a server (no P## suffix)', () => {
    expect(computeServerLabelFromDeviceName('samsung_SM-S908U')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('samsung_SM-A127F')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('TCL_T781SPP')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('Google_Pixel_4a')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('Wingtech_TMRV075G')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('Reliance_Communications_R678L5')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('motorola_moto_g_pure')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for junk or incomplete rack tokens', () => {
    expect(computeServerLabelFromDeviceName('port 3118 Reliance_Communications_R678L5')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('_Test_Simulator_jam')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('S16')).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName(null)).toBe('UNKNOWN');
    expect(computeServerLabelFromDeviceName('   ')).toBe('UNKNOWN');
  });
});
