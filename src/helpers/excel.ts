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
  /**
   * Excel number format for the whole column — `INR_FORMAT`, `COUNT_FORMAT`,
   * `DATE_FORMAT`.
   *
   * The format is what makes a number readable without making it text. A figure
   * written as "₹3,000.00" by the exporter is a string, and a column of strings
   * cannot be totalled, sorted or charted — which is most of what a spreadsheet
   * is for. The value stays 3000; Excel does the rendering.
   */
  numFmt?: string;
  /** Right-align, as figures should be so their digits line up down the column. */
  align?: 'left' | 'right' | 'center';
  /**
   * Include this column in the TOTAL row.
   *
   * Opt-in rather than "every numeric column": summing an id, a per-unit price
   * or a days-remaining produces a confident, meaningless number.
   */
  total?: boolean;
}

/** Header fill — dark enough that the bold white text reads at a glance. */
const HEADER_FILL = 'FF1F2937';

/**
 * Indian money: ₹ with lakh/crore grouping, always two decimals.
 *
 * Three clauses because Excel cannot express Indian digit grouping in one — the
 * 2-2-3 pattern has to be spelled out per magnitude.
 */
export const INR_FORMAT =
  '[>=10000000]"₹"##\\,##\\,##\\,##0.00;[>=100000]"₹"##\\,##\\,##0.00;"₹"##,##0.00';

/** A plain count, grouped the same way and with no decimals. */
export const COUNT_FORMAT = '[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0';

/** "26 Oct 2026". A real date cell, so Excel can sort and filter it as one. */
export const DATE_FORMAT = 'dd mmm yyyy';

/**
 * Paint a band across EXACTLY `width` columns, and no further.
 *
 * Not `row.fill = …`, which is what this replaces: a fill assigned to the ROW is
 * written to the sheet as a row-level style, and Excel renders a row-level style
 * across the whole row — all 16,384 columns. A five-column export then shows a
 * band of colour running off to the edge of the window with nothing in it.
 */
const paintBand = (row: ExcelJS.Row, width: number, font: Partial<ExcelJS.Font>): void => {
  for (let column = 1; column <= width; column += 1) {
    const cell = row.getCell(column);

    cell.font = font;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  }
};

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
  options: {
    sheetName: string;
    /**
     * Lines written above the header, one per row, then a blank row.
     *
     * This is where an export records **what it is** — the report's name and the
     * filters that produced it. A spreadsheet outlives the screen that made it:
     * six weeks later "members.xlsx" in someone's downloads folder is an
     * argument about whether it included inactive members, and the only way to
     * end that argument is for the file to say so itself.
     *
     * Omit it and the sheet is byte-for-byte what it was before this existed.
     */
    caption?: string[];
    /**
     * A title strip above the header, in the header's own colour.
     *
     * For a sheet that sits beside others in one workbook: "Detail" as a tab
     * name says where you are, not what you are looking at.
     */
    title?: string;
    /**
     * Add a bold TOTAL row under the data, summing every column marked
     * `total`.
     *
     * Only written when there is more than one row: a total under a single row
     * restates it, and a reader who sees the same figure twice starts wondering
     * which one is which.
     */
    totals?: boolean;
  },
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

  /*
    `sheet.columns` puts the header on row 1. With a caption the header has to
    move down, so the caption lines are SPLICED IN above it rather than appended
    — which keeps the column widths and keys that assignment just established.
  */
  const captionLines = options.caption ?? [];
  const titleLines = options.title ? [options.title] : [];
  const above = [...titleLines, ...captionLines];
  const headerRowNumber = above.length > 0 ? above.length + 2 : 1;

  if (titleLines.length > 0) {
    sheet.spliceRows(1, 0, [options.title as string]);

    const band = sheet.getRow(1);

    paintBand(band, columns.length, { bold: true, size: 12, color: { argb: 'FFFFFFFF' } });
    // Left, so the title starts where the first column does rather than
    // drifting to the middle of the merged band.
    band.alignment = { horizontal: 'left', vertical: 'middle' };
    band.height = 22;

    if (columns.length > 1) sheet.mergeCells(1, 1, 1, columns.length);
  }

  if (captionLines.length > 0) {
    // One blank row between the caption and the header, so the two do not read
    // as one block of text.
    sheet.spliceRows(titleLines.length + 1, 0, ...captionLines.map((line) => [line]), []);

    captionLines.forEach((_line, index) => {
      const row = sheet.getRow(titleLines.length + index + 1);

      row.font = { italic: true, size: 10, color: { argb: 'FF6B7280' } };
      // First line is the report's name; give it the weight of a title.
      if (index === 0) row.font = { bold: true, size: 12 };
    });
  }

  if (titleLines.length > 0 && captionLines.length === 0) {
    sheet.spliceRows(2, 0, []);
  }

  const header = sheet.getRow(headerRowNumber);

  paintBand(header, columns.length, { bold: true, color: { argb: 'FFFFFFFF' } });
  header.alignment = { vertical: 'middle' };
  header.height = 20;

  for (const row of rows) {
    sheet.addRow(columns.map((column) => column.value(row) ?? ''));
  }

  /*
    A totals row, over the columns where a total means something.

    Written after the data and before the formats, so it picks up the same
    number format as the column it sits under — a total rendered differently
    from the figures above it reads as a different kind of number.
  */
  if (options.totals && rows.length > 1 && columns.some((column) => column.total)) {
    const totalRow = sheet.addRow(
      columns.map((column, index) => {
        if (index === 0) return 'TOTAL';
        if (!column.total) return '';

        return rows.reduce((sum, row) => sum + (Number(column.value(row)) || 0), 0);
      }),
    );

    totalRow.font = { bold: true };
    totalRow.border = { top: { style: 'thin' } };
  }

  columns.forEach((column, index) => {
    const sheetColumn = sheet.getColumn(index + 1);

    if (column.numFmt) sheetColumn.numFmt = column.numFmt;
    if (column.align) sheetColumn.alignment = { horizontal: column.align };
  });

  // Freeze through the header, caption included: scrolling a long export must
  // not scroll away the line that says what the export IS.
  sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];

  // A filter across the header, so the person who opened the file can narrow it
  // further without asking for another export.
  if (columns.length > 0) {
    sheet.autoFilter = {
      from: { row: headerRowNumber, column: 1 },
      to: { row: headerRowNumber, column: columns.length },
    };
  }

  const buffer = await workbook.xlsx.writeBuffer();

  return Buffer.from(buffer);
};

/** The MIME type Excel expects. Anything else and the browser offers to save it as a .zip. */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
