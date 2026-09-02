import { z } from 'zod';
import type { ReportParams as RepoParams } from '@modules/report/report.repository';

/**
 * Reports (AJ-10, screen A-29).
 *
 * The organising idea of this module: **a report declares its columns once**,
 * and both the screen and the Excel export are rendered from that one
 * declaration. The self-test requires the export to carry the same rows and the
 * same columns as the screen; making them two hand-maintained lists would make
 * that a matter of discipline, and discipline drifts. Here they cannot differ,
 * because there is only one list.
 *
 * The consequence worth knowing: the API returns `{ columns, rows }`, not just
 * rows. The admin screen renders whatever columns it is given, so adding a
 * report — or a column to one — is a backend-only change.
 */

export const REPORT_TYPES = ['members', 'revenue', 'renewals', 'events', 'statement'] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

/**
 * How a cell should be rendered, on screen and in the sheet.
 *
 * `money` is separate from `number` because the two want opposite things: money
 * crosses the wire as a 2-decimal string (ADR-007 — a float is what turns
 * ₹25,000.10 into ₹25,000.099999) and is right-aligned with a currency prefix on
 * screen, while in Excel it must land as a real number the office can sum.
 */
export type ColumnType = 'text' | 'number' | 'money' | 'date' | 'status';

export interface ReportColumn {
  key: string;
  header: string;
  type: ColumnType;
  /** For `status`: which `constant/status.ts` domain the chip should resolve in. */
  domain?: string;
  /** Approximate character width in the exported sheet. */
  width?: number;
}

/** One row, keyed by column. Money arrives as a string; dates as ISO. */
export type ReportRow = Record<string, string | number | null>;

export interface ReportResult {
  columns: ReportColumn[];
  rows: ReportRow[];
  total: number;
}

/**
 * A repeated filter arrives as `?status=A,B`. Split, trim and drop blanks, so a
 * trailing comma or an empty selection is an absent filter rather than a 422.
 */
const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        : undefined,
    )
    .pipe(z.array(item).nonempty().optional());

/** `YYYY-MM-DD`, as a date filter arrives on the query string. */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.invalidDate')
  .optional();

/**
 * One schema for every report, rather than four.
 *
 * Each report ignores the parameters that do not apply to it, which is the same
 * contract the list endpoints already have: a parameter with no meaning here is
 * "no opinion", not an error. The alternative — a discriminated union keyed on
 * the path parameter — would reject `?status=` on the revenue report, and the
 * screen would then have to remember to strip a filter when switching reports,
 * which is exactly the sort of thing it will forget.
 */
/**
 * A filter selection carries the display name beside the id, on purpose.
 *
 * A report is a historical record. If a category is renamed or a company
 * terminated six months from now, an id-only filter becomes unreadable and the
 * saved numbers stop being explainable — you are left with a total and no way
 * to say what it counted. The name costs a few bytes and keeps the report
 * honest.
 */
export const filterRefSchema = z.object({
  id: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
});

export type FilterRef = z.infer<typeof filterRefSchema>;

/** Selections keyed by filter, exactly as they are stored on the report row. */
export type ReportFilters = Record<string, FilterRef[]>;

/**
 * Which filter keys each report accepts — one source of truth, read by the
 * generate schema's validation here and mirrored by the drawer.
 *
 * Events takes an event filter and not a member one: "which events did this
 * member attend" is a different report from "how did these events do", and
 * offering the filter would promise the first while running the second.
 */
export const REPORT_FILTER_KEYS = {
  members: ['status', 'category_id', 'city', 'state', 'member_id'],
  revenue: ['invoice_type', 'member_id'],
  renewals: ['status', 'member_id'],
  events: ['event_id'],
  /*
    One member, and only one. A statement is a document ABOUT a company — the
    thing you send when they query their dues — and two members in one statement
    is two documents that cannot be sent to either of them.
  */
  statement: ['member_id'],
} as const satisfies Record<ReportType, readonly string[]>;

/** Filters that may carry at most one value, whatever the shared shape allows. */
export const SINGLE_VALUE_FILTERS: Partial<Record<ReportType, readonly string[]>> = {
  statement: ['member_id'],
};

/** Filters a report cannot run without. */
export const REQUIRED_FILTERS: Partial<Record<ReportType, readonly string[]>> = {
  statement: ['member_id'],
};

/**
 * The stored refs, as the four queries want them.
 *
 * `type` is taken but unused: the caller has already validated that every key
 * present belongs to that report, so this only has to translate. Keeping the
 * parameter means a per-report translation can land here later without every
 * call site changing.
 */
export const toRepoParams = (
  type: ReportType,
  filters: ReportFilters,
  from?: string,
  to?: string,
): RepoParams => {
  // An empty selection is no filter at all, never "match nothing".
  const ids = (key: string): string[] | undefined => {
    const refs = filters[key];

    return refs && refs.length > 0 ? refs.map((ref) => ref.id) : undefined;
  };

  void type;

  const statuses = ids('status');
  const categoryIds = ids('category_id');
  const cities = ids('city');
  const states = ids('state');
  const invoiceTypes = ids('invoice_type');
  const memberIds = ids('member_id');
  const eventIds = ids('event_id');

  return {
    ...(statuses ? { statuses } : {}),
    ...(categoryIds ? { categoryIds } : {}),
    ...(cities ? { cities } : {}),
    ...(states ? { states } : {}),
    ...(invoiceTypes ? { invoiceTypes } : {}),
    ...(memberIds ? { memberIds } : {}),
    ...(eventIds ? { eventIds } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
};

/**
 * A worksheet cannot hold more than this. A result beyond it is refused at
 * generate time rather than silently truncated — a file that looks complete but
 * has quietly dropped rows is worse than no file at all.
 */
export const EXCEL_MAX_ROWS = 1_048_576;

/** The body of `POST /admin/reports`. */
export const generateReportSchema = z
  .object({
    report_type: z.enum(REPORT_TYPES),
    report_name: z.string().trim().min(1).max(200),
    from_date: dateOnly,
    to_date: dateOnly,
    filters: z.record(z.string(), z.array(filterRefSchema).nonempty()).default({}),
    // The screen sends this explicitly; the default is what a caller that omits
    // it gets, and a report without its rows is the narrower answer.
    include_details: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    const allowed = REPORT_FILTER_KEYS[value.report_type] as readonly string[];

    for (const key of Object.keys(value.filters)) {
      if (!allowed.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['filters', key],
          // Accepting a filter the query ignores would record a narrowing that
          // never happened: the sheet's caption would claim it and the numbers
          // would not show it.
          message: `Filter "${key}" is not valid for a ${value.report_type} report.`,
        });
      }

      if ((SINGLE_VALUE_FILTERS[value.report_type] ?? []).includes(key)) {
        if ((value.filters[key]?.length ?? 0) > 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['filters', key],
            message: `A ${value.report_type} report takes only one ${key.replace(/_id$/, '')}.`,
          });
        }
      }
    }

    /*
      A statement with no member is not a narrower statement — it is a different
      report, and running it would quietly produce every member's invoices under
      a heading that says it is one company's.
    */
    for (const key of REQUIRED_FILTERS[value.report_type] ?? []) {
      if (!value.filters[key]?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['filters', key],
          message: `A ${value.report_type} report needs a ${key.replace(/_id$/, '')}.`,
        });
      }
    }
  });

export type GenerateReportInput = z.infer<typeof generateReportSchema>;

/** The query of `GET /admin/reports` — the list of what has been generated. */
export const listGeneratedSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(20)
    .transform((value) => Math.min(value, 100)),
  /** Matched against the report's name, server-side, so highlighting is honest. */
  search: z.string().trim().min(1).max(200).optional(),
  report_type: z.enum(REPORT_TYPES).optional(),
  generated_by: z.string().regex(/^\d+$/, 'validation.invalidId').optional(),
});

export type ListGeneratedQuery = z.infer<typeof listGeneratedSchema>;

export const generatedIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'validation.invalidId'),
});

export const reportQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(20)
    .transform((value) => Math.min(value, 100)),

  search: z.string().trim().min(1).max(150).optional(),

  /** Members: `MemberStatus`. Renewals: `TermStatus`. Validated by the query. */
  status: csv(z.string().trim().min(1).max(40)),
  category_id: csv(z.string().regex(/^\d+$/, 'validation.invalidId')),
  city: csv(z.string().trim().min(1).max(100)),
  state: csv(z.string().trim().min(1).max(100)),

  /** Revenue: invoice issue date. Renewals: term expiry. Events: event date. */
  from: dateOnly,
  to: dateOnly,
  invoice_type: csv(z.string().trim().min(1).max(40)),
});

export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const reportTypeParamSchema = z.object({
  type: z.enum(REPORT_TYPES, {
    errorMap: () => ({ message: 'report.unknownType' }),
  }),
});
