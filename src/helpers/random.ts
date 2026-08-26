import crypto from 'crypto';

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPERCASE_ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Cryptographically-random alphanumeric string of `length` characters.
 *
 * Used for the 16-character noise prefix in `helpers/encryption.ts` and for
 * opaque refresh tokens. `crypto.randomBytes` rather than `Math.random`: the
 * same helper will later mint refresh tokens, where predictability is a
 * vulnerability rather than a nuisance.
 */
export const generateString = (length: number, upperCaseOnly = false): string => {
  const charset = upperCaseOnly ? UPPERCASE_ALPHANUMERIC : ALPHANUMERIC;
  const bytes = crypto.randomBytes(length);
  let result = '';

  for (let index = 0; index < length; index += 1) {
    result += charset.charAt(bytes[index] % charset.length);
  }

  return result;
};

/** RFC 4122 v4 UUID from the platform CSPRNG. Storage keys and correlation ids. */
export const uuidv4 = (): string => crypto.randomUUID();
