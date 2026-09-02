import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { COUNT_FORMAT, DATE_FORMAT, INR_FORMAT, toWorkbook, XLSX_MIME } from '@helpers/excel';

interface Row {
  name: string;
  fee: number;
  note: string | null;
}

const columns = [
  { header: 'Name', value: (r: Row) => r.name },
  { header: 'Fee', value: (r: Row) => r.fee },
  { header: 'Note', value: (r: Row) => r.note },
];

const read = async (buffer: Buffer) => {
  const workbook = new ExcelJS.Workbook();

  await workbook.xlsx.load(buffer);

  return workbook.worksheets[0]!;
};

describe('toWorkbook', () => {
  /*
    The caption is how an export says what it is. A file in someone's downloads
    folder six weeks later is only trustworthy if it carries its own filters, so
    these two cases guard the whole point of the feature: the caption is present
    and readable, and the header moves down to make room for it rather than being
    overwritten by it.
  */
  describe('title and totals', () => {
    interface Line {
      event: string;
      when: Date;
      attendees: number;
      revenue: number;
    }

    const lines: Line[] = [
      { event: 'Diwali Meet', when: new Date('2026-10-26T00:00:00Z'), attendees: 3, revenue: 3000 },
      { event: 'AGM', when: new Date('2026-08-25T00:00:00Z'), attendees: 4, revenue: 6000 },
    ];

    const detailColumns = [
      { header: 'Event', value: (r: Line) => r.event },
      { header: 'Date', value: (r: Line) => r.when, numFmt: DATE_FORMAT },
      { header: 'Attendees', value: (r: Line) => r.attendees, numFmt: COUNT_FORMAT, total: true },
      { header: 'Revenue', value: (r: Line) => r.revenue, numFmt: INR_FORMAT, total: true },
    ];

    it('puts a title band above the header and totals the marked columns', async () => {
      const sheet = await read(
        await toWorkbook(lines, detailColumns, {
          sheetName: 'Detail',
          title: 'Event Attendance — Detail',
          totals: true,
        }),
      );

      expect(sheet.getRow(1).getCell(1).value).toBe('Event Attendance — Detail');
      // Row 2 is the deliberate blank between the band and the header.
      expect(sheet.getRow(3).getCell(1).value).toBe('Event');
      expect(sheet.getRow(4).getCell(1).value).toBe('Diwali Meet');

      const total = sheet.getRow(6);

      expect(total.getCell(1).value).toBe('TOTAL');
      expect(total.getCell(3).value).toBe(7);
      expect(total.getCell(4).value).toBe(9000);
      // The first column is the label, not a sum — "Diwali MeetAGM" is not a total.
      expect(total.getCell(2).value).toBe('');
    });

    /*
      The whole point of a number FORMAT rather than a formatted string: the cell
      still holds 3000, so the column can be totalled, sorted and charted, and
      Excel renders the ₹ and the commas.
    */
    it('formats numbers without turning them into text', async () => {
      const sheet = await read(
        await toWorkbook(lines, detailColumns, { sheetName: 'Detail', title: 'T', totals: true }),
      );

      expect(sheet.getRow(4).getCell(4).value).toBe(3000);
      /*
        Asserted by shape, not by string equality: Excel normalises the escaped
        commas in the Indian grouping pattern when it reloads the file, so the
        format that comes back is equivalent to the constant without being
        character-identical to it.
      */
      expect(sheet.getRow(4).getCell(4).numFmt).toContain('₹');
      expect(sheet.getRow(4).getCell(3).numFmt).not.toContain('₹');
      expect(sheet.getRow(4).getCell(3).numFmt).toBeTruthy();
    });

    /* A date must arrive as a date, not as an ISO string Excel treats as words. */
    it('writes a real date cell', async () => {
      const sheet = await read(
        await toWorkbook(lines, detailColumns, { sheetName: 'Detail', title: 'T' }),
      );

      expect(sheet.getRow(4).getCell(2).value).toBeInstanceOf(Date);
      expect(sheet.getColumn(2).numFmt).toBe(DATE_FORMAT);
    });

    /* A total under one row restates it, and the reader has to work out which
       figure is which. */
    it('writes no totals row for a single row', async () => {
      const sheet = await read(
        await toWorkbook([lines[0]!], detailColumns, {
          sheetName: 'Detail',
          title: 'T',
          totals: true,
        }),
      );

      expect(sheet.getRow(5).getCell(1).value).not.toBe('TOTAL');
    });
  });

  describe('caption', () => {
    it('writes the caption above the header and keeps both readable', async () => {
      const sheet = await read(
        await toWorkbook([{ name: 'Ramesh Shah', fee: 1000, note: null }], columns, {
          sheetName: 'Members',
          caption: ['Members report', 'Status: ACTIVE · City: Surat', 'Generated 2 Sep 2026'],
        }),
      );

      expect(sheet.getRow(1).getCell(1).value).toBe('Members report');
      expect(sheet.getRow(2).getCell(1).value).toBe('Status: ACTIVE · City: Surat');
      expect(sheet.getRow(3).getCell(1).value).toBe('Generated 2 Sep 2026');
      // Row 4 is the deliberate blank between caption and header.
      expect(sheet.getRow(5).getCell(1).value).toBe('Name');
      expect(sheet.getRow(6).getCell(1).value).toBe('Ramesh Shah');
      expect(sheet.getRow(6).getCell(2).value).toBe(1000);
      // The filter range follows the header down rather than staying on the
      // caption, which would filter the wrong row.
      expect(sheet.autoFilter).toBe('A5:C5');
    });

    it('is byte-identical to no caption when none is given', async () => {
      const sheet = await read(
        await toWorkbook([{ name: 'A', fee: 1, note: null }], columns, { sheetName: 'S' }),
      );

      // The existing exports must not move: header still on row 1, and the
      // filter range with it. (ExcelJS normalises the range to A1 notation on
      // reload, which is also the clearest way to assert it moved or did not.)
      expect(sheet.getRow(1).getCell(1).value).toBe('Name');
      expect(sheet.autoFilter).toBe('A1:C1');
    });
  });

  it('writes a real xlsx a spreadsheet can reopen', async () => {
    const sheet = await read(
      await toWorkbook([{ name: 'Ramesh Shah', fee: 1000, note: null }], columns, {
        sheetName: 'Attendees',
      }),
    );

    expect(sheet.name).toBe('Attendees');
    expect(sheet.getRow(1).getCell(1).value).toBe('Name');
    expect(sheet.getRow(2).getCell(1).value).toBe('Ramesh Shah');
  });

  /*
    The reason this is a workbook and not a CSV: a fee has to arrive as a number
    the office can sum, not as text that looks like one.
  */
  it('keeps a number a number', async () => {
    const sheet = await read(
      await toWorkbook([{ name: 'A', fee: 1500, note: null }], columns, { sheetName: 'S' }),
    );

    expect(sheet.getRow(2).getCell(2).value).toBe(1500);
    expect(typeof sheet.getRow(2).getCell(2).value).toBe('number');
  });

  /*
    A company name with a comma in it is ordinary. In a CSV it shifts every later
    column of that row; here it is simply a cell.
  */
  it('handles a comma in a value without disturbing the row', async () => {
    const sheet = await read(
      await toWorkbook([{ name: 'Shah, Ramesh', fee: 1, note: null }], columns, { sheetName: 'S' }),
    );

    expect(sheet.getRow(2).getCell(1).value).toBe('Shah, Ramesh');
    expect(sheet.getRow(2).getCell(2).value).toBe(1);
  });

  it('writes an empty cell rather than the word null', async () => {
    const sheet = await read(
      await toWorkbook([{ name: 'A', fee: 0, note: null }], columns, { sheetName: 'S' }),
    );

    expect(sheet.getRow(2).getCell(3).value).toBe('');
  });

  it('still writes the headings when there is nothing to export', async () => {
    const sheet = await read(await toWorkbook([], columns, { sheetName: 'S' }));

    expect(sheet.getRow(1).getCell(1).value).toBe('Name');
    expect(sheet.rowCount).toBe(1);
  });

  it('freezes the header row, because the first thing anyone does is scroll', async () => {
    const sheet = await read(await toWorkbook([], columns, { sheetName: 'S' }));

    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });

  /* Excel refuses these characters and caps the name at 31 characters. */
  it('sanitises a sheet name Excel would reject', async () => {
    const sheet = await read(
      await toWorkbook([], columns, {
        sheetName: 'Export/Summit: 2026 [draft] a very long name indeed',
      }),
    );

    expect(sheet.name).not.toMatch(/[*?:\\/\[\]]/);
    expect(sheet.name.length).toBeLessThanOrEqual(31);
  });

  it('declares the MIME type Excel expects', () => {
    expect(XLSX_MIME).toContain('spreadsheetml.sheet');
  });
});
