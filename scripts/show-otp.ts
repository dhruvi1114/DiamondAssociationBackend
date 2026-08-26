/* eslint-disable no-console */
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadEnvironmentFiles } from '../src/config/loadEnv';

/**
 * Print recent verification codes from the notification outbox.
 *
 *   npm run otp                       # last 5, any address
 *   npm run otp -- someone@x.com      # last 5 for one address
 *
 * Why this exists: until SMTP credentials arrive, `MAIL_TRANSPORT=console`, so a
 * signup code never leaves the machine — it lands in `Notifications.payload_json`
 * (ADR-015). Digging it out by hand needs the app's Postgres role, which is not
 * the shell's default role, so it is a small pile of flags every time.
 *
 * Refuses to run outside local/dev. Printing live members' one-time codes on a
 * shared environment would hand over account access, which is precisely the sort
 * of "helpful" tool that becomes a breach (`observability.md` §8 bans the same
 * thing for decryption).
 */
const appEnv = loadEnvironmentFiles(path.join(__dirname, '..'));

if (appEnv !== 'local' && appEnv !== 'dev') {
  console.error(
    `Refusing to run with APP_ENV=${appEnv}. Verification codes are readable in local/dev only.`,
  );
  process.exit(1);
}

const prisma = new PrismaClient({ log: ['error'] });
const address = process.argv[2]?.trim();

const main = async (): Promise<void> => {
  const rows = await prisma.notification.findMany({
    where: {
      template_code: { startsWith: 'auth.' },
      ...(address ? { to_address: address } : {}),
    },
    orderBy: { id: 'desc' },
    take: 5,
    select: {
      to_address: true,
      template_code: true,
      status: true,
      payload_json: true,
      createdAt: true,
    },
  });

  if (rows.length === 0) {
    console.log(address ? `No codes for ${address}.` : 'No codes yet. Sign up first.');

    return;
  }

  const now = Date.now();

  for (const row of rows) {
    const payload = (row.payload_json ?? {}) as Record<string, unknown>;
    const otp = typeof payload.otp === 'string' ? payload.otp : '—';
    const minutes = Number(payload.expiry_minutes ?? 10);
    const ageMs = now - row.createdAt.getTime();
    const expired = ageMs > minutes * 60_000;
    const ageMin = Math.floor(ageMs / 60_000);

    console.log(
      [
        expired ? 'EXPIRED' : 'VALID  ',
        otp.padEnd(8),
        row.to_address.padEnd(32),
        row.template_code.padEnd(22),
        row.status.padEnd(7),
        `${ageMin}m ago`,
      ].join(' '),
    );
  }
};

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
