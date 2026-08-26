import ExcelJS from 'exceljs';

/**
 * Excel (.xlsx) rendering for admin exports.
 *
 * A real workbook, not a CSV renamed. CSV loses everything the office actually
 * needs from an export: a number stays a number rather than becoming text, a
 * long name does not shift the columns after it, and a phone number keeping its
 * leading zero is not a formatting argument. It also opens without the import
 * dialog that turns "download the list" into a support call.
 *
 * Kept in one place so every export in the platform has the same frozen header
 * row, the same column widths and the same look, whichever screen produced it.
 */

export interface ExcelColumn<T> {
  /** The heading a human reads. */
  header: string;
  /** The cell value. Numbers stay numbers; Excel is told so. */
  value: (row: T) => string | number | Date | null | undefined;
  /** Approximate character width. Omitted columns size themselves from content. */
  width?: number;
}

/** Header fill — dark enough that the bold white text reads at a glance. */
const HEADER_FILL = 'FF1F2937';

/**
 * Rows to an .xlsx buffer.
 *
 * The header row is frozen, because the first thing anyone does with an
 * attendee list is scroll it, and a list whose headings scroll away is a list
 * you have to keep scrolling back up.
 */
export const toWorkbook = async <T>(
  rows: T[],
  columns: ExcelColumn<T>[],
  options: { sheetName: string; title?: string },
): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();

  workbook.created = new Date();

  // Excel refuses these characters in a sheet name and caps it at 31 chars, so
  // the caller's title is sanitised rather than allowed to produce a file that
  // will not open.
  const sheet = workbook.addWorksheet(options.sheetName.replace(/[*?:\\/\[\]]/g, '-').slice(0, 31));

  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.header,
    width: column.width ?? Math.max(12, column.header.length + 4),
  }));

  const header = sheet.getRow(1);

  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  header.alignment = { vertical: 'middle' };
  header.height = 20;

  for (const row of rows) {
    sheet.addRow(columns.map((column) => column.value(row) ?? ''));
  }

  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  // A filter across the header, so the person who opened the file can narrow it
  // further without asking for another export.
  if (columns.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  }

  const buffer = await workbook.xlsx.writeBuffer();

  return Buffer.from(buffer);
};

/** The MIME type Excel expects. Anything else and the browser offers to save it as a .zip. */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
