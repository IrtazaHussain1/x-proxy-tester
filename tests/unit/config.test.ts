import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Configuration Validation', () => {
  beforeEach(() => {
    // Clear environment variables before each test
    delete process.env.DATABASE_URL;
    delete process.env.XPROXY_API_URL;
    delete process.env.XPROXY_API_TOKEN;
  });

  it('should throw error when required environment variables are missing', () => {
    // Mock the config import to catch the error
    expect(() => {
      // This will fail because required vars are missing
      vi.resetModules();
      require('../src/config');
    }).toThrow();
  });

  it('should validate TEST_INTERVAL_MS minimum value', () => {
    process.env.DATABASE_URL = 'mysql://test:test@localhost:3306/test';
    process.env.XPROXY_API_URL = 'https://test.com';
    process.env.XPROXY_API_TOKEN = 'test-token';
    process.env.TEST_INTERVAL_MS = '500'; // Less than 1000ms

    vi.resetModules();
    expect(() => {
      require('../src/config');
    }).toThrow('TEST_INTERVAL_MS must be at least 1000ms');
  });

  it('should validate REQUEST_TIMEOUT_MS minimum value', () => {
    process.env.DATABASE_URL = 'mysql://test:test@localhost:3306/test';
    process.env.XPROXY_API_URL = 'https://test.com';
    process.env.XPROXY_API_TOKEN = 'test-token';
    process.env.REQUEST_TIMEOUT_MS = '500'; // Less than 1000ms

    vi.resetModules();
    expect(() => {
      require('../src/config');
    }).toThrow('REQUEST_TIMEOUT_MS must be at least 1000ms');
  });

  it('should validate ROTATION_THRESHOLD minimum value', () => {
    process.env.DATABASE_URL = 'mysql://test:test@localhost:3306/test';
    process.env.XPROXY_API_URL = 'https://test.com';
    process.env.XPROXY_API_TOKEN = 'test-token';
    process.env.ROTATION_THRESHOLD = '0'; // Less than 1

    vi.resetModules();
    expect(() => {
      require('../src/config');
    }).toThrow('ROTATION_THRESHOLD must be at least 1');
  });

  it('should validate RUN_MODE values', () => {
    process.env.DATABASE_URL = 'mysql://test:test@localhost:3306/test';
    process.env.XPROXY_API_URL = 'https://test.com';
    process.env.XPROXY_API_TOKEN = 'test-token';
    process.env.RUN_MODE = 'invalid';

    vi.resetModules();
    expect(() => {
      require('../src/config');
    }).toThrow('RUN_MODE must be either "infinite" or "fixed"');
  });
});

