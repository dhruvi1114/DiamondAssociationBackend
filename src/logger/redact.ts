/**
 * Recursive redaction denylist (observability.md §3).
 *
 * The rule is deliberately blunt: if a key looks like it holds a secret, its
 * value never reaches a log file. False positives cost a little debuggability;
 * a false negative writes a member's PAN or an admin's refresh token to disk
 * where it is then backed up, shipped and retained for 14 days.
 */

/** Keys redacted when the (lowercased) key CONTAINS one of these fragments. */
const DENY_SUBSTRINGS = [
  'password',
  'passwd',
  'passphrase',
  'token',
  'secret',
  'authorization',
  'credential',
  'signature',
  'cookie',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'decrypted',
  'ciphertext',
  'pan_number',
  'gst_number',
  'iec_code',
  'trade_license',
  'aadhaar',
  'account_number',
  'ifsc',
  'card',
  'cvv',
  'otp',
];

/**
 * Keys redacted only on an EXACT (lowercased) match. These words are too short
 * or too common to match as substrings — `data` would otherwise swallow
 * `metadata` and `database`.
 */
const DENY_EXACT = new Set([
  'data',
  'body',
  'rawbody',
  'raw_body',
  'code_hash',
  'token_hash',
  'password_hash',
  'passwordhash',
  'iv',
  'key',
  'teriff',
  'plan',
  'chiper',
]);

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;

const isSensitiveKey = (key: string): boolean => {
  const lower = key.toLowerCase();

  return DENY_EXACT.has(lower) || DENY_SUBSTRINGS.some((fragment) => lower.includes(fragment));
};

/**
 * Deep-clone `value`, replacing every sensitive value with `[REDACTED]`.
 * Cycles and over-deep structures collapse to a marker rather than throwing —
 * a logger that can crash the request is worse than a missing log line.
 */
export const redact = (value: unknown, depth = 0, seen = new WeakSet<object>()): unknown => {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return '[TRUNCATED]';
  }

  if (seen.has(value)) {
    return '[CIRCULAR]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1, seen));
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return `[Buffer ${value.length} bytes]`;
  }

  const result: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redact(entry, depth + 1, seen);
  }

  return result;
};

/** Exposed for the self-test suite, which asserts the denylist actually bites. */
export const isRedactedKey = isSensitiveKey;
