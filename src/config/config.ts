import path from 'path';
import { z } from 'zod';
import { loadEnvironmentFiles } from '@config/loadEnv';

// real process.env > .env.<APP_ENV> > .env — see loadEnv.ts for why.
const appEnv = loadEnvironmentFiles(process.cwd());

const booleanFromString = z
  .string()
  .default('false')
  .transform((value) => ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()));

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const envSchema = z.object({
  // ---- runtime ----------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'dev', 'staging', 'production']).default('local'),
  PORT: z.string().default('4000'),
  PUBLIC_BASE_URL: z.string().min(1, 'PUBLIC_BASE_URL is required'),

  // ---- database ---------------------------------------------------------
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // ---- auth -------------------------------------------------------------
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('30m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  // Staff sessions are deliberately shorter than members' (rbac.md §1): an admin
  // session is worth far more to an attacker and staff sign in from fixed places.
  JWT_ADMIN_REFRESH_EXPIRES_IN: z.string().default('1d'),

  // ---- payload encryption (ADR-004, Elvee parity) -----------------------
  CHIPER: z.string().min(1, 'CHIPER is required'),
  TERIFF: z.string().length(32, 'TERIFF must be exactly 32 characters (AES-256 key)'),
  PLAN: z.string().length(16, 'PLAN must be exactly 16 characters (AES-CBC IV)'),

  // ---- i18n -------------------------------------------------------------
  APP_LANGUAGES: z.string().default('en'),

  // ---- http -------------------------------------------------------------
  CORS_ORIGINS: z
    .string()
    .min(1, 'CORS_ORIGINS is required (comma separated; "*" is not allowed)')
    .refine((value) => !csv(value).includes('*'), {
      message: 'CORS_ORIGINS must never contain "*" (security.md §5)',
    }),
  TRUST_PROXY_HOPS: z.string().default('1'),

  // ---- storage (ADR-017) ------------------------------------------------
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_PATH: z.string().min(1, 'STORAGE_PATH is required'),

  // ---- jobs (ADR-009) ---------------------------------------------------
  ENABLE_JOBS: booleanFromString,

  // ---- mail (ADR-015 / A-13) -------------------------------------------
  MAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
  MAIL_FROM: z.string().default('Association Platform <no-reply@localhost>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  SMTP_SECURE: booleanFromString,
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  CRASH_MAIL: z.string().optional(),

  // ---- seeds (never hardcoded; seed script fails loudly when unset) -----
  SEED_SUPERADMIN_EMAIL: z.string().optional(),
  SEED_SUPERADMIN_PASSWORD: z.string().optional(),

  // ---- observability ----------------------------------------------------
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  SLOW_REQUEST_MS: z.string().default('1000'),

  // ---- rate limiting (api-conventions.md §9) ----------------------------
  RATE_LIMIT_WINDOW_MS: z.string().default('900000'),
  RATE_LIMIT_MAX: z.string().default('300'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const fieldErrors = parsed.error.flatten().fieldErrors;
  console.error(
    'Invalid environment configuration. Fix the following keys in .env / .env.%s:\n%s',
    appEnv,
    Object.entries(fieldErrors)
      .map(([key, messages]) => `  - ${key}: ${(messages ?? []).join('; ')}`)
      .join('\n'),
  );
  throw new Error('Invalid environment configuration. See logs for details.');
}

const env = parsed.data;

if (env.MAIL_TRANSPORT === 'smtp' && !env.SMTP_HOST) {
  throw new Error('MAIL_TRANSPORT=smtp requires SMTP_HOST to be set.');
}

const languages = csv(env.APP_LANGUAGES);

export const environment = {
  nodeEnv: env.NODE_ENV,
  appEnv: env.APP_ENV,
  isLocal: env.APP_ENV === 'local',
  isProduction: env.APP_ENV === 'production',
  port: Number(env.PORT),
  publicBaseUrl: env.PUBLIC_BASE_URL,

  databaseUrl: env.DATABASE_URL,

  jwtSecret: env.JWT_SECRET,
  jwtRefreshSecret: env.JWT_REFRESH_SECRET,
  jwtAccessExpiresIn: env.JWT_ACCESS_EXPIRES_IN,
  jwtRefreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  jwtAdminRefreshExpiresIn: env.JWT_ADMIN_REFRESH_EXPIRES_IN,

  cipher: env.CHIPER,
  encryptionKey: env.TERIFF,
  encryptionIv: env.PLAN,

  languages: languages.length > 0 ? languages : ['en'],
  defaultLanguage: (languages.length > 0 ? languages : ['en'])[0],

  corsOrigins: csv(env.CORS_ORIGINS),
  trustProxyHops: Number(env.TRUST_PROXY_HOPS),

  storageDriver: env.STORAGE_DRIVER,
  storagePath: path.resolve(env.STORAGE_PATH),

  enableJobs: env.ENABLE_JOBS,

  mail: {
    transport: env.MAIL_TRANSPORT,
    from: env.MAIL_FROM,
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ? Number(env.SMTP_PORT) : 587,
    secure: env.SMTP_SECURE,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    crashMail: env.CRASH_MAIL,
  },

  seed: {
    superAdminEmail: env.SEED_SUPERADMIN_EMAIL,
    superAdminPassword: env.SEED_SUPERADMIN_PASSWORD,
  },

  logLevel: env.LOG_LEVEL,
  slowRequestMs: Number(env.SLOW_REQUEST_MS),

  rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS),
  rateLimitMax: Number(env.RATE_LIMIT_MAX),
} as const;

export type Environment = typeof environment;
