import { prisma } from '@db/prisma';
import { getNumericSetting, SETTING_KEYS } from '@helpers/settings';
import { addDays, dbToday, isoDay } from '@modules/renewal/renewal.dates';
import { runRenewalCycle } from '@modules/renewal/renewal.lifecycle';
import * as repo from '@modules/renewal/renewal.repository';
import type { BucketListQuery } from '@modules/renewal/renewal.types';

/**
 * The renewal window — today, and how far out the notice period reaches — behind every bucket
 * count and list row (A-20). Read fresh on each call: an admin changing the notice or grace
 * setting must see the buckets move without a redeploy.
 */
const windowNow = async () => {
  const today = dbToday();
  const noticeDays = await getNumericSetting(SETTING_KEYS.RENEWAL_NOTICE_DAYS, 15);
  const graceDays = await getNumericSetting(SETTING_KEYS.MEMBERSHIP_GRACE_DAYS, 30);
  return { today, noticeDays, graceDays, horizon: addDays(today, noticeDays) };
};

/** `GET /admin/renewals/summary` — the three bucket counts behind A-20's tiles. */
export const getSummary = async () => {
  const w = await windowNow();
  const counts = await repo.bucketSummary(prisma, w.today, w.horizon);
  return { ...counts, notice_days: w.noticeDays, grace_days: w.graceDays };
};

/** `GET /admin/renewals` — one bucket's rows, paginated. */
export const listBucket = async (q: BucketListQuery) => {
  const w = await windowNow();
  const rows = await repo.bucketRows(prisma, {
    bucket: q.bucket,
    today: w.today,
    horizon: w.horizon,
    search: q.search || null,
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const total = rows[0]?.total ?? 0;

  return {
    data: rows.map((r) => ({
      member_id: r.member_id.toString(),
      member_code: r.member_code,
      company_name: r.company_name,
      plan_name: r.plan_name,
      billing_cycle: r.billing_cycle,
      valid_till: isoDay(r.valid_till),
      grace_ends_on: isoDay(addDays(r.valid_till, w.graceDays)),
      renewal_term_id: r.renewal_term_id?.toString() ?? null,
      renewal_status: r.renewal_status,
      invoice_id: r.invoice_id?.toString() ?? null,
      invoice_number: r.invoice_number,
      invoice_total: r.invoice_total?.toFixed(2) ?? null,
      invoice_status: r.invoice_status,
      claim_pending: r.claim_pending,
      renewal_declined: r.renewal_declined,
    })),
    pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
  };
};

/** "Generate Invoices": the same cycle the schedule runs — only members inside the window are billed. */
export const runNow = () => runRenewalCycle();
