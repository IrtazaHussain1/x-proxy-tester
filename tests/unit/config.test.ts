import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Prevent .env on disk from satisfying "missing required vars" scenarios.
vi.mock('dotenv/config', () => ({}));

function setBaseEnv(): void {
  process.env.DATABASE_URL = 'mysql://test:test@localhost:3306/test';
  process.env.XPROXY_API_URL = 'https://test.com';
  process.env.XPROXY_LOGIN_EMAIL = 'test@example.com';
  process.env.XPROXY_LOGIN_PASSWORD = 'test-password';
}

async function importConfig(): Promise<typeof import('../../src/config/index')> {
  vi.resetModules();
  return import('../../src/config/index');
}

describe('Configuration Validation', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      'DATABASE_URL',
      'XPROXY_API_URL',
      'XPROXY_LOGIN_EMAIL',
      'XPROXY_LOGIN_PASSWORD',
      'TEST_INTERVAL_MS',
      'REQUEST_TIMEOUT_MS',
      'ROTATION_THRESHOLD',
      'RUN_MODE',
    ]) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.resetModules();
  });

  it('should throw error when required environment variables are missing', async () => {
    await expect(importConfig()).rejects.toThrow(/Missing required environment variables/);
  });

  it('should validate TEST_INTERVAL_MS minimum value', async () => {
    setBaseEnv();
    process.env.TEST_INTERVAL_MS = '500';

    await expect(importConfig()).rejects.toThrow('TEST_INTERVAL_MS must be at least 1000ms');
  });

  it('should validate REQUEST_TIMEOUT_MS minimum value', async () => {
    setBaseEnv();
    process.env.REQUEST_TIMEOUT_MS = '500';

    await expect(importConfig()).rejects.toThrow('REQUEST_TIMEOUT_MS must be at least 1000ms');
  });

  it('should validate ROTATION_THRESHOLD minimum value', async () => {
    setBaseEnv();
    process.env.ROTATION_THRESHOLD = '0';

    await expect(importConfig()).rejects.toThrow('ROTATION_THRESHOLD must be at least 1');
  });

  it('should validate RUN_MODE values', async () => {
    setBaseEnv();
    process.env.RUN_MODE = 'invalid';

    await expect(importConfig()).rejects.toThrow('RUN_MODE must be either "infinite" or "fixed"');
  });
});
