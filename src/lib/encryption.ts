/**
 * Encryption Module
 * 
 * Provides encryption/decryption utilities for sensitive data like proxy passwords.
 * Uses AES-256-GCM for authenticated encryption.
 * 
 * @module lib/encryption
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';
import { logger } from './logger';

const scryptAsync = promisify(scrypt);
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 32 bytes for AES-256
const IV_LENGTH = 16; // 16 bytes for GCM
const SALT_LENGTH = 32; // 32 bytes for salt

/**
 * Get encryption key from environment variable or generate from password
 */
async function getEncryptionKey(): Promise<Buffer> {
  const encryptionKey = process.env.ENCRYPTION_KEY;

  if (!encryptionKey) {
    logger.warn(
      'ENCRYPTION_KEY not set. Using default key (NOT SECURE FOR PRODUCTION). Set ENCRYPTION_KEY environment variable.'
    );
    // Generate a deterministic key from a default password (NOT SECURE - for development only)
    const defaultPassword = 'x-proxy-tester-default-key-change-in-production';
    const salt = Buffer.from('x-proxy-tester-salt-change-in-production');
    return (await scryptAsync(defaultPassword, salt, KEY_LENGTH)) as Buffer;
  }

  // If key is provided, use it directly (should be 32 bytes/64 hex chars)
  if (encryptionKey.length === 64) {
    // Hex encoded key
    return Buffer.from(encryptionKey, 'hex');
  }

  // Derive key from password using scrypt
  const salt = Buffer.from(process.env.ENCRYPTION_SALT || 'x-proxy-tester-salt', 'utf8');
  return (await scryptAsync(encryptionKey, salt, KEY_LENGTH)) as Buffer;
}

/**
 * Encrypt a string value
 * 
 * @param plaintext - The value to encrypt
 * @returns Encrypted value as base64 string (format: salt:iv:tag:encrypted)
 */
export async function encrypt(plaintext: string): Promise<string> {
  if (!plaintext) {
    return plaintext;
  }

  try {
    const key = await getEncryptionKey();
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);

    // Derive key from master key and salt
    const derivedKey = (await scryptAsync(key, salt, KEY_LENGTH)) as Buffer;

    const cipher = createCipheriv(ALGORITHM, derivedKey, iv);
    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    const tag = cipher.getAuthTag();

    // Format: salt:iv:tag:encrypted (all base64 encoded)
    const result = [
      salt.toString('base64'),
      iv.toString('base64'),
      tag.toString('base64'),
      encrypted.toString('base64'),
    ].join(':');

    return result;
  } catch (error) {
    logger.error({ error }, 'Encryption failed');
    throw new Error('Failed to encrypt value');
  }
}

/**
 * Decrypt a string value
 * 
 * @param ciphertext - The encrypted value (format: salt:iv:tag:encrypted)
 * @returns Decrypted plaintext
 */
export async function decrypt(ciphertext: string): Promise<string> {
  if (!ciphertext || !ciphertext.includes(':')) {
    // If not encrypted format, return as-is (for backward compatibility)
    return ciphertext;
  }

  try {
    const key = await getEncryptionKey();
    const parts = ciphertext.split(':');

    if (parts.length !== 4) {
      throw new Error('Invalid encrypted format');
    }

    const [saltBase64, ivBase64, tagBase64, encryptedBase64] = parts;

    const salt = Buffer.from(saltBase64, 'base64');
    const iv = Buffer.from(ivBase64, 'base64');
    const tag = Buffer.from(tagBase64, 'base64');
    const encrypted = Buffer.from(encryptedBase64, 'base64');

    // Derive key from master key and salt
    const derivedKey = (await scryptAsync(key, salt, KEY_LENGTH)) as Buffer;

    const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString('utf8');
  } catch (error) {
    logger.error({ error }, 'Decryption failed');
    // Return original value if decryption fails (for backward compatibility)
    return ciphertext;
  }
}

/**
 * Check if a value is encrypted
 */
export function isEncrypted(value: string): boolean {
  if (!value) return false;
  const parts = value.split(':');
  return parts.length === 4;
}

/**
 * Generate a secure encryption key (for setup)
 * Use this to generate ENCRYPTION_KEY for production
 */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_LENGTH).toString('hex');
}

