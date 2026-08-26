import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { toWorkbook, XLSX_MIME } from '@helpers/excel';

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
