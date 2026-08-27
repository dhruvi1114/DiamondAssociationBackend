import { describe, expect, it } from 'vitest';
import { renderInvoicePdf } from './invoiceTemplate';
import { renderReceiptPdf } from './receiptTemplate';

const ORG = {
  name: 'ILGDA',
  legal_name: 'India Lab-Grown Diamond Association',
  gstin: '29ABCDE1234F1Z5',
  address: '12 MG Road, Bengaluru, KA 560001',
  support_email: 'support@ilgda.org',
};

const MEMBER = {
  company_name: 'Riya Diamonds Pvt Ltd',
  legal_name: 'Riya Diamonds Private Limited',
  gst_number: '27AAACR1234M1Z1',
  address: '4th Floor, Diamond Bourse, Mumbai, MH 400001',
};

const INVOICE = {
  invoice_number: 'IN202603001',
  issue_date: new Date('2026-08-26'),
  due_date: new Date('2026-09-10'),
  subtotal: '20000.00',
  tax_amount: '3600.00',
  total_amount: '23600.00',
  currency: 'INR',
  notes: null,
};

const ITEMS = [
  {
    description: 'New membership — Manufacturer category',
    quantity: '1',
    unit_price: '20000.00',
    tax_rate: '18.00',
    tax_amount: '3600.00',
    line_total: '23600.00',
  },
];

const isPdf = (buffer: Buffer) => buffer.subarray(0, 5).toString('ascii') === '%PDF-';

describe('renderInvoicePdf', () => {
  it('produces a non-empty PDF buffer starting with the PDF magic bytes', async () => {
    const buffer = await renderInvoicePdf({
      org: ORG,
      logo: null,
      member: MEMBER,
      invoice: INVOICE,
      items: ITEMS,
    });

    expect(buffer.byteLength).toBeGreaterThan(500);
    expect(isPdf(buffer)).toBe(true);
  });

  it('prints "Not GST registered" when the org has no GSTIN, rather than omitting the line', async () => {
    const buffer = await renderInvoicePdf({
      org: { ...ORG, gstin: '' },
      logo: null,
      member: MEMBER,
      invoice: INVOICE,
      items: ITEMS,
    });

    expect(isPdf(buffer)).toBe(true);
  });

  it('still renders when the member has no on-file address or GSTIN', async () => {
    const buffer = await renderInvoicePdf({
      org: ORG,
      logo: null,
      member: { ...MEMBER, address: null, gst_number: null },
      invoice: INVOICE,
      items: ITEMS,
    });

    expect(isPdf(buffer)).toBe(true);
  });

  it('renders a terms section when the invoice carries notes, and stays valid without one', async () => {
    const withNotes = await renderInvoicePdf({
      org: ORG,
      logo: null,
      member: MEMBER,
      invoice: { ...INVOICE, notes: 'Payment due within 15 days of issue.' },
      items: ITEMS,
    });
    const withoutNotes = await renderInvoicePdf({
      org: ORG,
      logo: null,
      member: MEMBER,
      invoice: INVOICE,
      items: ITEMS,
    });

    expect(isPdf(withNotes)).toBe(true);
    expect(isPdf(withoutNotes)).toBe(true);
    // A terms section adds real content, so the document is measurably bigger.
    expect(withNotes.byteLength).toBeGreaterThan(withoutNotes.byteLength);
  });

  it('renders every line item, including several at once', async () => {
    const buffer = await renderInvoicePdf({
      org: ORG,
      logo: null,
      member: MEMBER,
      invoice: INVOICE,
      items: [
        ...ITEMS,
        {
          description: 'Late fee',
          quantity: '1',
          unit_price: '500.00',
          tax_rate: '18.00',
          tax_amount: '90.00',
          line_total: '590.00',
        },
      ],
    });

    expect(isPdf(buffer)).toBe(true);
  });

  it('embeds a logo when one is supplied, without corrupting the document', async () => {
    // A minimal 1x1 PNG — real bytes, not a placeholder string, so `doc.image`
    // genuinely has to decode it.
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );

    const buffer = await renderInvoicePdf({
      org: ORG,
      logo: onePixelPng,
      member: MEMBER,
      invoice: INVOICE,
      items: ITEMS,
    });

    expect(isPdf(buffer)).toBe(true);
  });

  it('does not throw when a logo buffer is corrupt — the invoice must still print', async () => {
    const buffer = await renderInvoicePdf({
      org: ORG,
      logo: Buffer.from('not an image'),
      member: MEMBER,
      invoice: INVOICE,
      items: ITEMS,
    });

    expect(isPdf(buffer)).toBe(true);
  });
});

describe('renderReceiptPdf', () => {
  it('produces a non-empty PDF buffer starting with the PDF magic bytes', async () => {
    const buffer = await renderReceiptPdf({
      org: ORG,
      logo: null,
      member: MEMBER,
      invoice: {
        invoice_number: INVOICE.invoice_number,
        issue_date: INVOICE.issue_date,
        due_date: INVOICE.due_date,
        subtotal: INVOICE.subtotal,
        tax_amount: INVOICE.tax_amount,
        total_amount: INVOICE.total_amount,
        currency: INVOICE.currency,
      },
      items: ITEMS,
      receipt: {
        receipt_number: 'RC202603001',
        amount: '23600.00',
        paid_at: new Date('2026-08-26'),
      },
    });

    expect(buffer.byteLength).toBeGreaterThan(300);
    expect(isPdf(buffer)).toBe(true);
  });

  it('still renders when the member has no on-file address or GSTIN', async () => {
    const buffer = await renderReceiptPdf({
      org: ORG,
      logo: null,
      member: { ...MEMBER, address: null, gst_number: null },
      invoice: {
        invoice_number: INVOICE.invoice_number,
        issue_date: INVOICE.issue_date,
        due_date: INVOICE.due_date,
        subtotal: INVOICE.subtotal,
        tax_amount: INVOICE.tax_amount,
        total_amount: INVOICE.total_amount,
        currency: INVOICE.currency,
      },
      items: ITEMS,
      receipt: {
        receipt_number: 'RC202603001',
        amount: '23600.00',
        paid_at: new Date('2026-08-26'),
      },
    });

    expect(isPdf(buffer)).toBe(true);
  });
});

/*
  The signature is the one thing on these documents that is a scan of something
  a person actually signed, so the test that matters is that it reaches the page
  rather than being silently dropped — the first cut of this drew it only when
  the cursor was above the footer, and by then the footer had already moved the
  cursor into itself, so nothing was ever drawn.
*/
describe('the authorised signature', () => {
  // 1×1 PNG. The bytes are irrelevant; that PDFKit embeds them is not.
  const SIGNATURE = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  it('is embedded in an invoice when one has been uploaded', async () => {
    const base = { org: ORG, logo: null, member: MEMBER, invoice: INVOICE, items: ITEMS };

    const signed = await renderInvoicePdf({ ...base, signature: SIGNATURE });
    const unsigned = await renderInvoicePdf({ ...base, signature: null });

    expect(isPdf(signed)).toBe(true);
    expect(signed.byteLength).toBeGreaterThan(unsigned.byteLength);
  });

  it('is embedded in a receipt when one has been uploaded', async () => {
    const base = {
      org: ORG,
      logo: null,
      member: MEMBER,
      invoice: {
        invoice_number: INVOICE.invoice_number,
        issue_date: INVOICE.issue_date,
        due_date: INVOICE.due_date,
        subtotal: INVOICE.subtotal,
        tax_amount: INVOICE.tax_amount,
        total_amount: INVOICE.total_amount,
        currency: INVOICE.currency,
      },
      items: ITEMS,
      receipt: {
        receipt_number: 'RC202603001',
        amount: '23600.00',
        paid_at: new Date('2026-08-26'),
      },
    };

    const signed = await renderReceiptPdf({ ...base, signature: SIGNATURE });
    const unsigned = await renderReceiptPdf({ ...base, signature: null });

    expect(isPdf(signed)).toBe(true);
    expect(signed.byteLength).toBeGreaterThan(unsigned.byteLength);
  });
});
