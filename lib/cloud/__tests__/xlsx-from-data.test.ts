/**
 * Tests für lib/cloud/xlsx-from-data.ts (Built-In-Skill json-to-xlsx).
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { dataToXlsxBuffer, XlsxError, XLSX_MIME } from '../xlsx-from-data';

describe('dataToXlsxBuffer', () => {
  it('erzeugt eine gültige XLSX (ZIP/PK-Signatur) mit Header + Zeilen', async () => {
    const buf = await dataToXlsxBuffer({
      title: 'Mai-Report',
      sheets: [
        {
          name: 'Kosten',
          headers: ['Posten', 'Betrag'],
          rows: [
            ['Hosting', 42],
            ['Domains', 12.5],
          ],
        },
      ],
    });
    expect(buf.length).toBeGreaterThan(0);
    // XLSX ist ein ZIP → beginnt mit "PK".
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');

    // Re-Parse: Inhalt korrekt?
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Kosten')!;
    expect(ws).toBeTruthy();
    expect(ws.getRow(1).getCell(1).value).toBe('Posten');
    expect(ws.getRow(2).getCell(1).value).toBe('Hosting');
    expect(ws.getRow(2).getCell(2).value).toBe(42);
  });

  it('unterstützt mehrere Sheets', async () => {
    const buf = await dataToXlsxBuffer({
      title: 'Multi',
      sheets: [
        { name: 'A', headers: ['x'], rows: [['1']] },
        { name: 'B', headers: ['y'], rows: [['2']] },
      ],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['A', 'B']);
  });

  it('kappt unsichere/zu lange Tab-Namen (Excel-Limit 31, keine Sonderzeichen)', async () => {
    const buf = await dataToXlsxBuffer({
      title: 't',
      sheets: [{ name: 'Bericht/2026:Q[1]*?', headers: ['a'], rows: [] }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const name = wb.worksheets[0]!.name;
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[[\]:*?/\\]/);
  });

  it('wirft XlsxError bei leerer Sheet-Liste', async () => {
    await expect(dataToXlsxBuffer({ title: 't', sheets: [] })).rejects.toBeInstanceOf(XlsxError);
  });

  it('exportiert den korrekten OOXML-MIME', () => {
    expect(XLSX_MIME).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });
});
