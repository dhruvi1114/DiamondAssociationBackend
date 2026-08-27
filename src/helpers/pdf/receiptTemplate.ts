import PDFDocument from 'pdfkit';
import {
  drawFooter,
  drawHeader,
  drawLineItemsTable,
  drawPanel,
  drawSectionBar,
  drawSummary,
  formatDate,
  money,
  registerFonts,
  FONT_BOLD,
  INK,
  PAGE,
  type LineItem,
  type OrgInfo,
} from './pdfLayout';
import { drawIcon } from './icons';
import type { MemberInfo } from './invoiceTemplate';

export interface ReceiptInvoiceInfo {
  invoice_number: string;
  issue_date: Date;
  due_date: Date;
  subtotal: string;
  tax_amount: string;
  total_amount: string;
  currency: string;
}

export interface ReceiptInfo {
  receipt_number: string;
  amount: string;
  paid_at: Date;
}

export interface ReceiptTemplateInput {
  org: OrgInfo;
  logo: Buffer | null;
  /** The uploaded signature, or null when the association has not supplied one. */
  signature?: Buffer | null;
  member: MemberInfo;
  invoice: ReceiptInvoiceInfo;
  items: LineItem[];
  receipt: ReceiptInfo;
}

export const renderReceiptPdf = (input: ReceiptTemplateInput): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    registerFonts(doc);

    let y = drawHeader(doc, input.org, input.logo, {
      icon: 'receipt',
      title: 'PAYMENT RECEIPT',
      lines: [input.receipt.receipt_number, formatDate(input.receipt.paid_at)],
    });

    // --- Received from / invoice details, side by side -----------------------
    const panelWidth = (PAGE.contentRight - PAGE.margin - 20) / 2;
    const fromBottom = drawPanel(doc, {
      x: PAGE.margin,
      y,
      width: panelWidth,
      icon: 'user',
      label: 'RECEIVED FROM',
      heading: input.member.legal_name ?? input.member.company_name,
      lines: [
        input.member.address ?? '—',
        input.member.gst_number ? `GSTIN · ${input.member.gst_number}` : 'No GSTIN on file',
        `Against invoice ${input.invoice.invoice_number}`,
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

    y = Math.max(fromBottom, detailsBottom) + 20;

    y = drawSectionBar(doc, y, 'receipt', 'PAYMENT SUMMARY');
    y += 20;

    y = drawLineItemsTable(doc, y, input.items, input.invoice.currency);

    y = drawSummary(
      doc,
      y,
      input.invoice.subtotal,
      input.invoice.tax_amount,
      input.invoice.total_amount,
      input.invoice.currency,
    );

    // --- Amount received — the confirmation the whole document exists for ---
    const boxHeight = 54;
    doc
      .roundedRect(PAGE.margin, y, PAGE.contentRight - PAGE.margin, boxHeight, 6)
      .strokeColor(INK.rule)
      .stroke();
    drawIcon(doc, 'wallet', PAGE.margin + 14, y + 13, 28, INK.muted);
    doc
      .font(FONT_BOLD)
      .fillColor(INK.faint)
      .fontSize(8)
      .text('AMOUNT RECEIVED', PAGE.margin + 54, y + 13);
    doc
      .font(FONT_BOLD)
      .fillColor(INK.heading)
      .fontSize(15)
      .text(money(input.receipt.amount, input.invoice.currency), PAGE.margin + 54, y + 26);

    drawFooter(doc, input.org, input.signature);
    doc.end();
  });
