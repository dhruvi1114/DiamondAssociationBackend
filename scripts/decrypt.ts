/* eslint-disable no-console */
import path from 'node:path';
import CryptoJS from 'crypto-js';
import pako from 'pako';
import { loadEnvironmentFiles } from '../src/config/loadEnv';

/**
 * Local-only helper for pasting a ciphertext captured from the network tab
 * (observability.md §8).
 *
 *   npm run decrypt -- "U2FsdGVkX1+…"
 *
 * Refuses to run outside APP_ENV=local. Encrypted payloads make network-tab
 * debugging useless, which is the accepted cost of ADR-004; the compensation is
 * this CLI plus `decrypted_data` in local. There must never be a "decrypt this
 * for me" HTTP endpoint in a shared environment.
 */

const appEnv = loadEnvironmentFiles(path.join(__dirname, '..'));

if (appEnv !== 'local') {
  console.error(`Refusing to run with APP_ENV=${appEnv}. This helper is local-only.`);
  process.exit(1);
}

const ciphertext = process.argv[2];

if (!ciphertext) {
  console.error('Usage: npm run decrypt -- "<ciphertext>"');
  process.exit(1);
}

const key = process.env.TERIFF;
const iv = process.env.PLAN;

if (!key || !iv) {
  console.error('TERIFF and PLAN must be set.');
  process.exit(1);
}

try {
  const decrypted = CryptoJS.AES.decrypt(ciphertext, CryptoJS.enc.Utf8.parse(key), {
    iv: CryptoJS.enc.Utf8.parse(iv),
  }).toString(CryptoJS.enc.Utf8);

  // Drop the 16-character noise prefix, then base64-decode and ungzip.
  const binary = Buffer.from(decrypted.substring(16), 'base64');
  const json = new TextDecoder('utf-8').decode(pako.ungzip(new Uint8Array(binary)));

  console.log(JSON.stringify(JSON.parse(json), null, 2));
} catch (error) {
  console.error(
    'Could not decrypt. Wrong key/IV for this environment, or the string is truncated.',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
}
