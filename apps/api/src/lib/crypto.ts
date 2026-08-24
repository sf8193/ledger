import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'crypto';
import { logger } from './logger';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const secret = process.env.PLAID_TOKEN_KEY || process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('PLAID_TOKEN_KEY or BETTER_AUTH_SECRET must be at least 32 characters');
  }

  if (!process.env.PLAID_TOKEN_KEY) {
    logger.warn('PLAID_TOKEN_KEY not set — deriving from BETTER_AUTH_SECRET. Set a separate key for production.');
  }

  // Derive a proper 256-bit key using HKDF with domain separation
  return Buffer.from(
    hkdfSync('sha256', secret, '', 'plaid-token-encryption', 32)
  );
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decrypt(encoded: string): string {
  const key = getKey();
  const [ivB64, tagB64, dataB64] = encoded.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
