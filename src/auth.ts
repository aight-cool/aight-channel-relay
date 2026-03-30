/**
 * HMAC-based session token generation and verification.
 */

const encoder = new TextEncoder();

/** Matches a 6-digit numeric pairing code. */
export const PAIRING_CODE_RE = /^\d{6}$/;

/** Matches a 32-character lowercase hex session ID (16 random bytes). */
export const SESSION_ID_RE = /^[0-9a-f]{32}$/;

/** Matches a 64-character lowercase hex token (SHA-256 HMAC output). */
export const SESSION_TOKEN_RE = /^[0-9a-f]{64}$/;

/**
 * Generate a session token: HMAC-SHA256(secret, "v1:" + sessionId) as hex.
 */
export async function generateSessionToken(secret: string, sessionId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`v1:${sessionId}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time comparison of two strings.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  let diff = 0;
  for (let i = 0; i < aBuf.length; i++) {
    diff |= aBuf[i] ^ bBuf[i];
  }
  return diff === 0;
}

/**
 * Validate a session token by recomputing and comparing.
 */
export async function validateSessionToken(
  secret: string,
  sessionId: string,
  token: string,
): Promise<boolean> {
  const expected = await generateSessionToken(secret, sessionId);
  return constantTimeEqual(expected, token);
}

/**
 * Generate a random 6-digit pairing code.
 */
export function generatePairingCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(array[0] % 1000000).padStart(6, "0");
}

/**
 * Generate a random session ID (hex string).
 */
export function generateSessionId(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return [...array].map((b) => b.toString(16).padStart(2, "0")).join("");
}
