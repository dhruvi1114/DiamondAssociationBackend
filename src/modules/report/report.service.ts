import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import ExcelJS from 'exceljs';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { COUNT_FORMAT, DATE_FORMAT, INR_FORMAT, toWorkbook } from '@helpers/excel';
import * as repo from '@modules/report/report.repository';
import { EXCEL_MAX_ROWS, REPORT_FILTER_KEYS, toRepoParams } from '@modules/report/report.types';
import type {
  GenerateReportInput,
  ListGeneratedQuery,
  ReportColumn,
  ReportFilters,
  ReportQuery,
  ReportResult,
  ReportRow,
  ReportType,
} from '@modules/report/report.types';
import { AppError } from '@utils/appError';

/**
 * The report registry (AJ-10, screen A-29).
 *
 * Each entry declares its columns and its query. Nothing else in the platform
 * knows what a report's columns are — not the screen, not the export — so the
 * two cannot drift apart, and the self-test's "export columns match the screen"
 * holds by construction rather than by review.
 */

interface Definition {
  /** Shown on screen, in the sheet's caption, and in the download's filename. */
  label: string;
  columns: ReportColumn[];
  run: (db: typeof prisma, params: repo.ReportParams) => Promise<repo.ReportQueryResult>;
  /** Which query-string filters this report actually reads, for the caption. */
  filters: (keyof ReportQuery)[];
  /**
   * The headline figures for the Summary sheet.
   *
   * Computed here, from the same rows the report returned, so the totals can
   * never disagree with the rows they sit above — which is what a second query
   * "for the totals" eventually does.
   */
  summarise: (rows: ReportRow[]) => Record<string, string | number>;
  /**
   * A finer grain for the Detail sheet, where the report's own rows are not one.
   *
   * "Event Attendance" is one row per event, so asking for the breakdown of a
   * single event and getting that same single row back is not a breakdown — the
   * rows underneath an event are its attendees. Revenue is the same: a row is a
   * month, and underneath a month are its invoices.
   *
   * Absent where the summary rows already ARE the finest grain the report has,
   * which is the case for Members and Renewals.
   */
  detail?: {
    columns: ReportColumn[];
    run: (db: typeof prisma, params: repo.ReportParams) => Promise<repo.ReportQueryResult>;
  };
}

/** Sum one column across the rows. Money arrives as a string; it totals as a number. */
const sum = (rows: ReportRow[], key: string): number =>
  rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);

const REPORTS: Record<ReportType, Definition> = {
  members: {
    label: 'Members',
    columns: [
      { key: 'member_code', header: 'Member Code', type: 'text', width: 16 },
      { key: 'company_name', header: 'Company', type: 'text', width: 34 },
      { key: 'category', header: 'Category', type: 'text', width: 22 },
      { key: 'city', header: 'City', type: 'text', width: 18 },
      { key: 'state', header: 'State', type: 'text', width: 18 },
      { key: 'status', header: 'Status', type: 'status', domain: 'member', width: 16 },
      { key: 'joined_on', header: 'Joined', type: 'date', width: 14 },
    ],
    run: repo.members,
    filters: ['search', 'status', 'category_id', 'city', 'state'],
    summarise: (rows) => ({ 'Total Members': rows.length }),
  },

  revenue: {
    label: 'Revenue',
    columns: [
      { key: 'period', header: 'Month', type: 'text', width: 12 },
      { key: 'invoices', header: 'Invoices', type: 'number', width: 12 },
      { key: 'billed', header: 'Billed', type: 'money', width: 16 },
      { key: 'collected', header: 'Collected', type: 'money', width: 16 },
      { key: 'outstanding', header: 'Outstanding', type: 'money', width: 16 },
    ],
    run: repo.revenue,
    filters: ['from', 'to', 'invoice_type'],
    detail: {
      columns: [
        { key: 'invoice_number', header: 'Invoice No', type: 'text', width: 18 },
        { key: 'company_name', header: 'Company', type: 'text', width: 30 },
        { key: 'invoice_type', header: 'Type', type: 'text', width: 16 },
        { key: 'issue_date', header: 'Issued', type: 'date', width: 14 },
        { key: 'due_date', header: 'Due', type: 'date', width: 14 },
        { key: 'billed', header: 'Billed', type: 'money', width: 16 },
        { key: 'collected', header: 'Collected', type: 'money', width: 16 },
        { key: 'outstanding', header: 'Outstanding', type: 'money', width: 16 },
        { key: 'status', header: 'Status', type: 'status', domain: 'invoice', width: 16 },
      ],
      run: repo.revenueInvoices,
    },
    summarise: (rows) => ({
      Months: rows.length,
      'Total Billed': sum(rows, 'billed'),
      'Total Collected': sum(rows, 'collected'),
      'Total Outstanding': sum(rows, 'outstanding'),
    }),
  },

  renewals: {
    label: 'Renewals Due',
    columns: [
      { key: 'member_code', header: 'Member Code', type: 'text', width: 16 },
      { key: 'company_name', header: 'Company', type: 'text', width: 34 },
      { key: 'category', header: 'Category', type: 'text', width: 22 },
      { key: 'valid_from', header: 'Cover From', type: 'date', width: 14 },
      { key: 'valid_till', header: 'Expires', type: 'date', width: 14 },
      { key: 'days_remaining', header: 'Days Left', type: 'number', width: 12 },
      { key: 'status', header: 'Status', type: 'status', domain: 'term', width: 18 },
    ],
    run: repo.renewals,
    filters: ['from', 'to', 'status'],
    summarise: (rows) => ({
      'Total Terms': rows.length,
      // The two figures the report exists to surface, called out rather than
      // left to be counted by eye down a column of dates.
      'Already Lapsed': rows.filter((row) => Number(row.days_remaining) < 0).length,
      'Due Within 30 Days': rows.filter(
        (row) => Number(row.days_remaining) >= 0 && Number(row.days_remaining) <= 30,
      ).length,
    }),
  },

  events: {
    label: 'Event Attendance',
    columns: [
      { key: 'event', header: 'Event', type: 'text', width: 34 },
      { key: 'event_date', header: 'Date', type: 'date', width: 14 },
      { key: 'registrations', header: 'Bookings', type: 'number', width: 12 },
      { key: 'attendees', header: 'Attendees', type: 'number', width: 12 },
      { key: 'revenue', header: 'Revenue', type: 'money', width: 16 },
    ],
    run: repo.events,
    filters: ['search', 'from', 'to'],
    detail: {
      columns: [
        { key: 'event', header: 'Event', type: 'text', width: 30 },
        { key: 'event_date', header: 'Date', type: 'date', width: 14 },
        { key: 'attendee', header: 'Attendee', type: 'text', width: 26 },
        { key: 'designation', header: 'Designation', type: 'text', width: 22 },
        { key: 'email', header: 'Email', type: 'text', width: 28 },
        // Text, not a number: a phone number is not arithmetic, and as a number
        // Excel eats the leading zero and offers scientific notation.
        { key: 'phone', header: 'Phone', type: 'text', width: 16 },
        { key: 'booking', header: 'Booking', type: 'text', width: 18 },
        { key: 'amount', header: 'Amount', type: 'money', width: 14 },
      ],
      run: repo.eventAttendees,
    },
    summarise: (rows) => ({
      Events: rows.length,
      'Total Bookings': sum(rows, 'registrations'),
      'Total Attendees': sum(rows, 'attendees'),
      'Total Revenue': sum(rows, 'revenue'),
    }),
  },

  statement: {
    label: 'Member Statement',
    columns: [
      { key: 'invoice_number', header: 'Invoice No', type: 'text', width: 18 },
      { key: 'invoice_type', header: 'Type', type: 'text', width: 16 },
      { key: 'issue_date', header: 'Issued', type: 'date', width: 14 },
      { key: 'due_date', header: 'Due', type: 'date', width: 14 },
      { key: 'billed', header: 'Billed', type: 'money', width: 16 },
      { key: 'collected', header: 'Paid', type: 'money', width: 16 },
      { key: 'outstanding', header: 'Outstanding', type: 'money', width: 16 },
      { key: 'status', header: 'Status', type: 'status', domain: 'invoice', width: 16 },
    ],
    run: repo.memberStatement,
    filters: ['from', 'to'],
    summarise: (rows) => ({
      Invoices: rows.length,
      'Total Billed': sum(rows, 'billed'),
      'Total Paid': sum(rows, 'collected'),
      // Named "Balance Due" rather than "Outstanding": this is the figure the
      // company is being asked to settle, and it is the line they will read
      // first.
      'Balance Due': sum(rows, 'outstanding'),
    }),
    /*
      No finer grain. The invoice rows already ARE the statement — the thing the
      office sends — so dropping a level would replace the document with its
      own footnotes.
    */
  },
};

export const reportLabel = (type: ReportType): string => REPORTS[type].label;

export const reportColumns = (type: ReportType): ReportColumn[] => REPORTS[type].columns;

/** The headline figures for one report's rows. */
export const summarise = (type: ReportType, rows: ReportRow[]): Record<string, string | number> =>
  REPORTS[type].summarise(rows);

const toParams = (query: ReportQuery): repo.ReportParams => ({
  ...(query.search ? { search: query.search } : {}),
  ...(query.status ? { statuses: query.status } : {}),
  ...(query.category_id ? { categoryIds: query.category_id } : {}),
  ...(query.city ? { cities: query.city } : {}),
  ...(query.state ? { states: query.state } : {}),
  ...(query.from ? { from: query.from } : {}),
  ...(query.to ? { to: query.to } : {}),
  ...(query.invoice_type ? { invoiceTypes: query.invoice_type } : {}),
});

/** One page of a report, for the screen. */
export const runReport = async (type: ReportType, query: ReportQuery): Promise<ReportResult> => {
  const definition = REPORTS[type];
  const result = await definition.run(prisma, {
    ...toParams(query),
    page: query.page,
    limit: query.limit,
  });

  return { columns: definition.columns, rows: result.rows, total: result.total };
};

// ---------------------------------------------------------------------------
// Saved reports
// ---------------------------------------------------------------------------

export interface GeneratedReportDto {
  id: string;
  report_type: ReportType;
  report_name: string;
  from_date: string | null;
  to_date: string | null;
  filters: ReportFilters;
  include_details: boolean;
  status: string;
  row_count: number;
  generated_by: string;
  generated_by_name: string | null;
  createdAt: string;
}

const toGeneratedDto = (
  row: repo.GeneratedReportRow & { generated_by_name?: string | null },
): GeneratedReportDto => ({
  id: row.id.toString(),
  report_type: row.report_type as ReportType,
  report_name: row.report_name,
  // Date-only columns, rendered as they were stored: attaching a time here
  // would imply a precision the DATE column never had.
  from_date: row.from_date ? row.from_date.toISOString().slice(0, 10) : null,
  to_date: row.to_date ? row.to_date.toISOString().slice(0, 10) : null,
  filters: (row.filters ?? {}) as ReportFilters,
  include_details: row.include_details,
  status: row.status,
  row_count: Number(row.row_count),
  generated_by: row.generated_by.toString(),
  generated_by_name: row.generated_by_name ?? null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Run a report once and keep the answer.
 *
 * The row and its audit entry are written in ONE transaction, so a report that
 * appears in the list always has a trail saying who ran it — and a rolled-back
 * generate leaves neither.
 *
 * Detail rows are stored only when they were asked for. A report generated
 * without them keeps its summary and its row count and nothing else; the count
 * still says how many rows matched, so a later run with detail is a decision
 * made with the size already in hand.
 */
export const generateReport = async (
  input: GenerateReportInput,
  actor: { id: bigint; ip: string | null; userAgent: string | null; requestId: string | null },
): Promise<GeneratedReportDto> => {
  const definition = REPORTS[input.report_type];
  const params = toRepoParams(input.report_type, input.filters, input.from_date, input.to_date);

  /*
    Checked here as well as in the route's schema, and not out of caution.

    The filters are STORED and then printed above the figures in the sheet. A
    key this report does not read would be recorded and displayed as a narrowing
    that never happened — the numbers would be association-wide while the file
    claimed they were not. That is the one way a report can lie without being
    wrong, so the guard sits next to the write rather than only at the door.
  */
  const allowed = REPORT_FILTER_KEYS[input.report_type] as readonly string[];
  const stray = Object.keys(input.filters).find((key) => !allowed.includes(key));

  if (stray) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'report.invalidFilter',
      replacements: { filter: stray, report: input.report_type },
    });
  }

  const result = await definition.run(prisma, params);

  if (result.total > EXCEL_MAX_ROWS) {
    // Refused, not truncated. A file that looks complete but has quietly
    // dropped rows is worse than no file at all.
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'report.tooLarge',
      replacements: { rows: result.total.toLocaleString('en-IN') },
    });
  }

  /*
    The figures are stored as an ORDERED ARRAY, not an object.

    Postgres `jsonb` does not preserve object key order — it stores keys sorted
    by length and then alphabetically. An object came back as Events, Total
    Revenue, Total Bookings, Total Attendees: the order each report deliberately
    puts its figures in was silently rewritten by the storage layer, and the
    Summary sheet read in that arbitrary order. An array keeps what was written.
  */
  /*
    The Detail sheet is the finer grain where the report has one, and the
    report's own rows otherwise. `row_count` follows it: for an event report the
    number that matters is how many attendees, not how many events — and the
    self-test's "the sheet holds as many rows as the report says" has to compare
    the two things that are actually meant to match.
  */
  const detail = input.include_details
    ? definition.detail
      ? await definition.detail.run(prisma, params)
      : result
    : null;

  const reportData = {
    summary: Object.entries(definition.summarise(result.rows)).map(([label, value]) => ({
      label,
      value,
    })),
    detail: detail ? detail.rows : null,
    row_count: result.total,
    /** How many rows the Detail sheet holds, which is a different question. */
    detail_count: detail ? detail.total : 0,
  };

  return prisma.$transaction(async (tx) => {
    const row = await repo.insertGeneratedReport(tx, {
      reportType: input.report_type,
      reportName: input.report_name,
      fromDate: input.from_date ?? null,
      toDate: input.to_date ?? null,
      filters: input.filters,
      includeDetails: input.include_details,
      reportData,
      rowCount: result.total,
      generatedBy: actor.id,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.REPORT_GENERATED,
      entityName: 'GeneratedReports',
      entityId: row.id,
      after: {
        report_type: input.report_type,
        report_name: input.report_name,
        row_count: result.total,
        include_details: input.include_details,
      },
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return toGeneratedDto(row);
  });
};

/** The reports anyone has generated, newest first. */
export const listGeneratedReports = async (
  query: ListGeneratedQuery,
): Promise<{ rows: GeneratedReportDto[]; total: number }> => {
  const result = await repo.listGeneratedReports(prisma, {
    page: query.page,
    limit: query.limit,
    ...(query.search ? { search: query.search } : {}),
    ...(query.report_type ? { reportType: query.report_type } : {}),
    ...(query.generated_by ? { generatedBy: query.generated_by } : {}),
  });

  return { rows: result.rows.map(toGeneratedDto), total: result.total };
};

/** One headline figure, in the order its report chose to present them. */
export interface ReportFigure {
  label: string;
  value: string | number;
}

export interface GeneratedReportDetailDto extends GeneratedReportDto {
  columns: ReportColumn[];
  summary: ReportFigure[];
  /** NULL when the report was generated without the detail box ticked. */
  detail: ReportRow[] | null;
}

/** One report, with the figures it recorded and — if they were kept — its rows. */
export const getGeneratedReport = async (id: bigint): Promise<GeneratedReportDetailDto> => {
  const row = await repo.findGeneratedReport(prisma, id);

  if (!row) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'report.notFound' });
  }

  const data = (row.report_data ?? {}) as {
    summary?: ReportFigure[] | Record<string, string | number>;
    detail?: ReportRow[] | null;
    detail_count?: number;
  };

  /*
    Reports generated before the array change hold an object. Read both rather
    than migrating: a saved report is a historical record, and rewriting one to
    suit a later code shape is exactly what this table exists not to do.
  */
  const summary: ReportFigure[] = Array.isArray(data.summary)
    ? data.summary
    : Object.entries(data.summary ?? {}).map(([label, value]) => ({ label, value }));

  return {
    ...toGeneratedDto(row),
    // The columns come from the registry, not from the stored row: a report
    // generated before a column was renamed still renders under the current
    // heading, and there is still only one list of columns in the system.
    // The DETAIL sheet's columns, which are the finer grain's where there is
    // one. The summary rows are not returned, so returning their columns would
    // describe a table nobody is being shown.
    columns:
      REPORTS[row.report_type as ReportType].detail?.columns ??
      REPORTS[row.report_type as ReportType].columns,
    summary,
    detail: data.detail ?? null,
  };
};

// ---------------------------------------------------------------------------
// The workbook
// ---------------------------------------------------------------------------

const MAX_FILENAME_LENGTH = 120;

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * `{report-type}-{filters}-{date}.xlsx`.
 *
 * The filter labels are in the name because a downloads folder holding six
 * files called `members-2026-09-02.xlsx` is useless. The whole reason filters
 * are recorded is so a report can be told apart from its siblings, and the
 * filename is the first place that has to hold.
 */
export const buildReportFilename = (report: {
  report_type: string;
  filters: ReportFilters;
  createdAt: string;
}): string => {
  const date = report.createdAt.slice(0, 10);
  const labels = Object.values(report.filters ?? {})
    .flatMap((refs) => refs.map((ref) => slug(ref.name)))
    .filter(Boolean);

  const stem = [slug(report.report_type), ...labels].join('-');
  const suffix = `-${date}.xlsx`;
  const room = MAX_FILENAME_LENGTH - suffix.length;

  return `${stem.length > room ? stem.slice(0, room).replace(/-+$/, '') : stem}${suffix}`;
};

/**
 * The saved report as a workbook: a Summary sheet always, a Detail sheet when
 * the rows were kept.
 *
 * Rebuilt from the stored snapshot on every download rather than from a fresh
 * query — that is what makes the file the answer the report gave when it was
 * run, which is the entire reason reports are saved rather than recomputed.
 */
export const buildReportFile = async (
  id: bigint,
): Promise<{ filename: string; buffer: Buffer }> => {
  const report = await getGeneratedReport(id);
  const workbook = new ExcelJS.Workbook();

  workbook.created = new Date(report.createdAt);

  const summary = workbook.addWorksheet('Summary');

  summary.getColumn(1).width = 26;
  summary.getColumn(2).width = 52;

  const title = summary.addRow([`ILGDA — ${report.report_name}`]);

  /*
    Painted cell by cell across exactly two columns.

    A fill assigned to the ROW is written to the sheet as a row-level style, and
    Excel renders a row-level style across the whole row — all 16,384 columns.
    A two-column sheet then shows a page-wide band of colour behind nothing.
  */
  for (let column = 1; column <= 2; column += 1) {
    const cell = title.getCell(column);

    cell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
  }

  summary.addRow([
    `Generated: ${new Date(report.createdAt).toLocaleString('en-IN')}${
      report.generated_by_name ? ` · By: ${report.generated_by_name}` : ''
    }`,
  ]);
  summary.addRow([]);
  summary.addRow(['Report Type', REPORTS[report.report_type].label]);
  summary.addRow([
    'Date Range',
    report.from_date && report.to_date ? `${report.from_date} to ${report.to_date}` : 'N/A',
  ]);

  /*
    Filters are stated before any figure. A filtered number read as an
    association-wide total is the failure this whole design exists to prevent,
    and the only defence is that the file says what it counted before it says
    how many.
  */
  const entries = Object.entries(report.filters ?? {});

  if (entries.length === 0) {
    // Said explicitly: "no filters" and "the filter line failed to print" look
    // identical on a page, and only one of them is safe to act on.
    summary.addRow(['Filters Applied', 'None (all records)']);
  } else {
    entries.forEach(([key, refs], index) => {
      const label = key
        .replace(/_ids?$/, '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (character) => character.toUpperCase());

      summary.addRow([
        index === 0 ? 'Filters Applied' : '',
        `${label}: ${refs.map((ref) => ref.name).join(', ')}`,
      ]);
    });
  }

  summary.addRow([]);

  for (const figure of report.summary) {
    // Numbers stay numbers even in the summary block: this is a spreadsheet,
    // and a figure written as text cannot be totalled or charted.
    summary.addRow([
      figure.label,
      typeof figure.value === 'number' ? figure.value : String(figure.value),
    ]);
  }

  if (report.detail && report.detail.length > 0) {
    /*
      Built through the shared `toWorkbook` and copied in, rather than written
      by hand here. That keeps the Detail sheet identical in every respect to
      every other export in the platform — the same frozen header, the same
      header fill, the same auto-filter — with one definition of what an
      exported table looks like.
    */
    /*
      Built through the shared `toWorkbook` and copied in, rather than written by
      hand here. That keeps the Detail sheet identical in every respect to every
      other export in the platform — the same header band, the same frozen row,
      the same auto-filter — with one definition of what an exported table is.

      Every rendering decision below comes from the column's declared TYPE. The
      registry already knows a column is money or a date, so nothing here has to
      guess from its name the way an exporter without that declaration must.
    */
    const detailBuffer = await toWorkbook(
      report.detail,
      report.columns.map((column) => ({
        header: column.header,
        value: (row: ReportRow) => {
          const value = row[column.key];

          if (value === null || value === undefined || value === '') return '';

          // A real Date cell, not the ISO string the API sends. As text a date
          // cannot be sorted as a date or filtered by month, which is most of
          // what anyone opens a date column to do.
          if (column.type === 'date') {
            const parsed = new Date(String(value));

            return Number.isNaN(parsed.getTime()) ? String(value) : parsed;
          }

          // Money and counts land as real numbers so the column can be totalled;
          // the FORMAT does the rendering.
          if (column.type === 'money' || column.type === 'number') return Number(value);

          return String(value);
        },
        ...(column.width !== undefined ? { width: column.width } : {}),
        ...(column.type === 'money'
          ? { numFmt: INR_FORMAT, align: 'right' as const, total: true }
          : {}),
        ...(column.type === 'number'
          ? {
              numFmt: COUNT_FORMAT,
              align: 'right' as const,
              /*
                Counts total; a "days remaining" does not. Summing the days left
                on five memberships produces a confident, meaningless number, so
                that column is named out rather than swept in with the rest.
              */
              total: column.key !== 'days_remaining',
            }
          : {}),
        ...(column.type === 'date' ? { numFmt: DATE_FORMAT } : {}),
      })),
      {
        sheetName: 'Detail',
        title: `${REPORTS[report.report_type].label} — Detail`,
        totals: true,
      },
    );

    const source = new ExcelJS.Workbook();

    /*
      Cast because `@types/node` now parameterises Buffer over its backing store,
      while ExcelJS's signature still names the unparameterised `Buffer`. The
      value is correct at runtime; only the two declarations disagree.
    */
    await source.xlsx.load(detailBuffer as unknown as ArrayBuffer);

    const built = source.worksheets[0];

    if (built) {
      const detail = workbook.addWorksheet('Detail');

      // Column properties carry the number formats and the widths. Copying only
      // the cell values would land the figures unformatted — the exact bug this
      // change exists to fix.
      detail.columns = built.columns.map((column) => ({
        width: column.width,
        ...(column.numFmt ? { style: { numFmt: column.numFmt, alignment: column.alignment } } : {}),
      }));

      built.eachRow({ includeEmpty: true }, (row, index) => {
        const copied = detail.getRow(index);

        copied.values = row.values as ExcelJS.CellValue[];
        copied.height = row.height;
        copied.font = row.font;
        copied.border = row.border;
        copied.alignment = row.alignment;

        row.eachCell({ includeEmpty: false }, (cell, column) => {
          const target = copied.getCell(column);

          target.font = cell.font;
          target.fill = cell.fill;
          target.numFmt = cell.numFmt;
          target.alignment = cell.alignment;
        });

        copied.commit();
      });

      built.model.merges?.forEach((merge) => detail.mergeCells(merge));

      detail.views = built.views;
      detail.autoFilter = built.autoFilter;
    }
  }

  return {
    filename: buildReportFilename(report),
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
  };
};
