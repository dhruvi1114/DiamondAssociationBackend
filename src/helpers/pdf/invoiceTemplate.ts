import PDFDocument from 'pdfkit';
import {
  drawFooter,
  drawHeader,
  drawLineItemsTable,
  drawNoticeBox,
  drawPanel,
  drawSummary,
  formatDate,
  registerFonts,
  FONT_BOLD,
  FONT_SANS,
  INK,
  PAGE,
  type LineItem,
  type OrgInfo,
} from './pdfLayout';

/**
 * The one place the invoice's printed layout lives. Every GST-relevant field
 * (both GSTINs, the tax line, the line-item breakdown) is drawn explicitly
 * because a tax invoice missing any one of them is a compliance problem, not
 * a cosmetic one (billing-payment.md §7, OQ-8).
 *
 * Deliberately does NOT carry the fields a product invoice has and a
 * membership invoice does not — order reference, shipment, dispatch
 * warehouse, per-line discount, delivery charge. Inventing those would be
 * inventing data (CLAUDE.md: "do not invent business requirements").
 */

export type { OrgInfo } from './pdfLayout';

export interface MemberInfo {
  company_name: string;
  legal_name: string | null;
  gst_number: string | null;
  address: string | null;
}

export interface InvoiceInfo {
  invoice_number: string;
  issue_date: Date;
  due_date: Date;
  subtotal: string;
  tax_amount: string;
  total_amount: string;
  currency: string;
  /** Free text from `Invoices.notes`. Section is omitted entirely when blank. */
  notes: string | null;
}

export type InvoiceLineItem = LineItem;

export interface InvoiceTemplateInput {
  org: OrgInfo;
  logo: Buffer | null;
  /** The uploaded signature, or null when the association has not supplied one. */
  signature?: Buffer | null;
  member: MemberInfo;
  invoice: InvoiceInfo;
  items: InvoiceLineItem[];
}

export const renderInvoicePdf = (input: InvoiceTemplateInput): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    registerFonts(doc);

    let y = drawHeader(doc, input.org, input.logo, {
      icon: 'fileText',
      title: 'TAX INVOICE',
      lines: [input.invoice.invoice_number, formatDate(input.invoice.issue_date)],
    });

    // --- Bill to / invoice details, side by side -----------------------------
    const panelWidth = (PAGE.contentRight - PAGE.margin - 20) / 2;
    const billToBottom = drawPanel(doc, {
      x: PAGE.margin,
      y,
      width: panelWidth,
      icon: 'user',
      label: 'BILL TO',
      heading: input.member.legal_name ?? input.member.company_name,
      lines: [
        input.member.address ?? '—',
        input.member.gst_number ? `GSTIN · ${input.member.gst_number}` : 'No GSTIN on file',
      ],
    });
    const detailsBottom = drawPanel(doc, {
      x: PAGE.margin + panelWidth + 20,
      y,
      width: panelWidth,
      icon: 'fileText',
      label: 'INVOICE DETAILS',
      heading: input.invoice.invoice_number,
      lines: [
        `Issue date: ${formatDate(input.invoice.issue_date)}`,
        `Due date: ${formatDate(input.invoice.due_date)}`,
      ],
    });

    y = Math.max(billToBottom, detailsBottom) + 26;

    y = drawLineItemsTable(doc, y, input.items, input.invoice.currency);

    y = drawSummary(
      doc,
      y,
      input.invoice.subtotal,
      input.invoice.tax_amount,
      input.invoice.total_amount,
      input.invoice.currency,
    );

    // --- Terms (only when the association wrote one) --------------------------
    if (input.invoice.notes) {
      doc.font(FONT_BOLD).fillColor(INK.faint).fontSize(8).text('TERMS', PAGE.margin, y);
      y = doc.y + 6;
      doc
        .font(FONT_SANS)
        .fillColor(INK.body)
        .fontSize(9)
        .text(input.invoice.notes, PAGE.margin, y, { width: PAGE.contentRight - PAGE.margin });
      y = doc.y + 20;
    }

    drawNoticeBox(
      doc,
      y,
      'shieldCheck',
      'Thank you for your business.',
      'This is a system-generated invoice and does not require a signature.',
    );

    drawFooter(doc, input.org, input.signature);
    doc.end();
  });
