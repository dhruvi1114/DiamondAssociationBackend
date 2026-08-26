import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Loads environment files with the precedence a deployed service actually needs:
 *
 *   real process.env  >  .env.<APP_ENV>  >  .env
 *
 * Two rules, both learned the hard way:
 *
 * 1. **A real environment variable always wins.** In any container or process
 *    manager, secrets are injected into the environment, not written to a file.
 *    Loading a file with `override: true` (dotenv's opt-in, and the obvious
 *    reading of "overlay") silently discards those injected values.
 *
 * 2. **An empty value in a file is ignored, not applied.** The flavour templates
 *    ship with blank secrets so a misconfigured environment fails fast. Without
 *    this rule, a blank line in `.env.production` would mask a correctly
 *    injected `DATABASE_URL` and the failure would look like a missing secret
 *    rather than a shadowed one.
 *
 * Flavour is read before base so the more specific file fills a gap first.
 */
export const loadEnvironmentFiles = (projectRoot: string = process.cwd()): string => {
  const appEnv = process.env.APP_ENV || 'local';

  const files = [path.join(projectRoot, `.env.${appEnv}`), path.join(projectRoot, '.env')];

  for (const file of files) {
    if (!fs.existsSync(file)) {
      continue;
    }

    const parsed = dotenv.parse(fs.readFileSync(file));

    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined && value !== '') {
        process.env[key] = value;
      }
    }
  }

  return appEnv;
};
