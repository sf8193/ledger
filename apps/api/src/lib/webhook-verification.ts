import { decodeProtectedHeader, importJWK, jwtVerify, type JWK, type CryptoKey, type KeyObject } from 'jose';
import { getPlaidClient, isPlaidConfigured } from './plaid';
import crypto from 'crypto';
import { logger } from './logger';

type VerifyKey = CryptoKey | KeyObject;

// Cache JWKS keys for 24h to avoid hammering Plaid
const keyCache = new Map<string, { key: VerifyKey; expiresAt: number }>();
const KEY_TTL_MS = 24 * 60 * 60 * 1000;

async function getVerificationKey(kid: string): Promise<VerifyKey> {
  const cached = keyCache.get(kid);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.key;
  }

  const client = getPlaidClient();
  const response = await client.webhookVerificationKeyGet({ key_id: kid });
  const jwk = response.data.key;
  const key = await importJWK(jwk as JWK) as VerifyKey;

  keyCache.set(kid, { key, expiresAt: Date.now() + KEY_TTL_MS });
  return key;
}

/**
 * Verify a Plaid webhook JWT.
 * Returns true if valid, false if verification fails.
 * In sandbox mode (no Plaid-Verification header), skips verification.
 */
export async function verifyPlaidWebhook(
  verificationHeader: string | undefined,
  rawBody: string,
): Promise<boolean> {
  // Sandbox doesn't send signed webhooks
  if (!verificationHeader) {
    if (!isPlaidConfigured()) return true; // no Plaid at all, let through (tests)
    const env = process.env.PLAID_ENV || 'sandbox';
    if (env === 'sandbox') return true;
    // Production without header = reject
    return false;
  }

  try {
    // Decode header to get kid
    const decoded = decodeProtectedHeader(verificationHeader);
    if (!decoded.kid) return false;

    const key = await getVerificationKey(decoded.kid);

    // Verify JWT signature (max 5 min clock tolerance for network delays)
    const { payload } = await jwtVerify(verificationHeader, key, {
      maxTokenAge: '5 min',
    });

    // Verify request body hash
    const bodyHash = crypto
      .createHash('sha256')
      .update(rawBody)
      .digest('hex');

    if (payload.request_body_sha256 !== bodyHash) {
      logger.warn('Webhook body hash mismatch');
      return false;
    }

    return true;
  } catch (err: any) {
    logger.warn({ err }, 'Webhook JWT verification failed');
    return false;
  }
}
