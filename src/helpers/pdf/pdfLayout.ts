import fs from 'fs';
import path from 'path';
import type PDFDocument from 'pdfkit';
import { drawIcon, drawIconBadge, type IconName } from './icons';

/**
 * Shared drawing helpers for the invoice and receipt PDFs, so the two
 * documents read as one system rather than two unrelated layouts.
 *
 * Monochrome, matching the platform's own design system (`design-system.md`,
 * "ElevenLabs monochrome theme") — soft light-gray panels and thin rules, no
 * borrowed brand colour. The association's own logo is the only colour on
 * the page, once one is uploaded. Colours below are the exact tokens
 * `admin/src/styles/index.css` uses for `--fg`, `--fg-muted`, `--fg-subtle`,
 * `--surface-subtle` and `--border` — the PDF and the app read the same.
 */

export const PAGE = { margin: 50, width: 595.28, contentRight: 545.28 };

export const INK = {
  heading: '#171717',
  body: '#333333',
  muted: '#737373',
  faint: '#a3a3a3',
  panelFill: '#fafafa',
  highlightFill: '#f0f0f0',
  rule: '#e5e5e5',
  ruleStrong: '#bdbdbd',
};

/**
 * ─── Embedded typeface ───────────────────────────────────────────────────
 *
 * Geist — the same family the customer and admin apps render invoices in
 * (`admin/src/styles/index.css`) — via `@fontsource/geist-sans`, which ships
 * plain static font files in `node_modules` (no network fetch, no copy step).
 *
 * `.woff`, not `.woff2`, though fontsource ships both: pdfkit subsets
 * whatever it embeds, and fontkit's WOFF2 decoder throws "Offset is outside
 * the bounds of the DataView" while subsetting this family — reproduced
 * directly against this file, and already documented as the same failure in
 * a sibling codebase's invoice generator (`dribee-backend/invoice.service.ts`).
 * The static 400/700 `.woff` weights sidestep it entirely.
 *
 * pdfkit's built-in Helvetica (WinAnsi-encoded) has no glyph for the Rupee
 * sign (U+20B9) — Geist does, which is the whole reason to embed it rather
 * than rely on a base font.
 */
const fontFile = (file: string): string =>
  path.join(path.dirname(require.resolve('@fontsource/geist-sans/package.json')), 'files', file);

let FONTS: { sans: Buffer; bold: Buffer } | null = null;

const loadFonts = (): { sans: Buffer; bold: Buffer } => {
  if (!FONTS) {
    FONTS = {
      sans: fs.readFileSync(fontFile('geist-sans-latin-400-normal.woff')),
      bold: fs.readFileSync(fontFile('geist-sans-latin-700-normal.woff')),
    };
  }
  return FONTS;
};

export const FONT_SANS = 'Geist';
export const FONT_BOLD = 'Geist-Bold';

/** Registers both faces on this document and selects the regular weight. */
export function registerFonts(doc: InstanceType<typeof PDFDocument>): void {
  const fonts = loadFonts();
  doc.registerFont(FONT_SANS, fonts.sans);
  doc.registerFont(FONT_BOLD, fonts.bold);
  doc.font(FONT_SANS);
}

/** `₹2,71,506.00` — Indian digit grouping, which is what every figure on a
 *  real Indian tax invoice uses. Needs `registerFonts` to have run first. */
export const money = (value: string, currency: string): string => {
  const amount = Number(value).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return currency === 'INR' ? `₹${amount}` : `${currency} ${amount}`;
};

export const formatDate = (value: Date) =>
  value.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export interface OrgInfo {
  name: string;
  legal_name: string;
  /** Empty string means "not GST registered" — printed as such, not omitted. */
  gstin: string;
  address: string;
  support_email: string;
}

export interface LineItem {
  description: string;
  quantity: string;
  unit_price: string;
  tax_rate: string;
  line_total: string;
}

/**
 * Logo (in a bordered square, if the association has uploaded one) plus the
 * company block on the left; a caller-supplied title block — with its own
 * icon badge, the document's identity at a glance — on the right. Returns
 * the y-coordinate where the shared header ends.
 */
export function drawHeader(
  doc: InstanceType<typeof PDFDocument>,
  org: OrgInfo,
  logo: Buffer | null,
  titleBlock: { icon: IconName; title: string; lines: string[] },
): number {
  const top = doc.y;
  const logoBox = 50;
  const textX = PAGE.margin + logoBox + 14;

  if (logo) {
    doc.roundedRect(PAGE.margin, top, logoBox, logoBox, 6).strokeColor(INK.rule).stroke();
    try {
      doc.image(logo, PAGE.margin + 5, top + 5, { fit: [logoBox - 10, logoBox - 10] });
    } catch {
      // A corrupt or unreadable logo file must never take the document down —
      // the invoice still has to be printable without it.
    }
  }

  const nameX = logo ? textX : PAGE.margin;
  const nameWidth = 260;

  doc
    .font(FONT_BOLD)
    .fillColor(INK.heading)
    .fontSize(15)
    .text(org.name, nameX, top, { width: nameWidth });
  doc
    .font(FONT_SANS)
    .fillColor(INK.muted)
    .fontSize(9)
    .text(org.legal_name, nameX, doc.y + 2, { width: nameWidth })
    .text(org.address || '—', nameX, doc.y + 1, { width: nameWidth })
    .text(org.gstin ? `GSTIN · ${org.gstin}` : 'Not GST registered', nameX, doc.y + 1, {
      width: nameWidth,
    });

  const badgeSize = 34;
  const badgeX = PAGE.contentRight - badgeSize;
  drawIconBadge(doc, titleBlock.icon, badgeX, top, badgeSize, INK.panelFill, INK.heading);

  const titleTextWidth = badgeX - 12 - PAGE.margin;
  doc
    .font(FONT_BOLD)
    .fillColor(INK.heading)
    .fontSize(15)
    .text(titleBlock.title, PAGE.margin, top, { width: titleTextWidth, align: 'right' });
  doc.font(FONT_SANS).fillColor(INK.muted).fontSize(9);
  titleBlock.lines.forEach((line) => {
    doc.text(line, PAGE.margin, doc.y + 2, { width: titleTextWidth, align: 'right' });
  });

  const headerBottom = Math.max(doc.y, top + logoBox, top + badgeSize) + 18;
  doc
    .moveTo(PAGE.margin, headerBottom)
    .lineTo(PAGE.contentRight, headerBottom)
    .strokeColor(INK.rule)
    .stroke();
  doc.fillColor(INK.body);

  return headerBottom + 18;
}

/**
 * One soft light-grey panel — "BILL TO", "INVOICE DETAILS", "RECEIVED
 * FROM" — with an icon badge, sized to the tallest content it is asked to
 * hold, so a long address never overflows the box drawn under it.
 */
export function drawPanel(
  doc: InstanceType<typeof PDFDocument>,
  opts: {
    x: number;
    y: number;
    width: number;
    icon: IconName;
    label: string;
    heading: string;
    lines: string[];
  },
): number {
  const badgeSize = 32;
  const textX = opts.x + badgeSize + 22;
  const innerWidth = opts.width - (badgeSize + 22) - 12;

  doc.font(FONT_BOLD).fontSize(11);
  const headingHeight = doc.heightOfString(opts.heading, { width: innerWidth });
  doc.font(FONT_SANS).fontSize(9);
  const linesHeight = opts.lines.reduce(
    (sum, line) => sum + doc.heightOfString(line, { width: innerWidth }) + 3,
    0,
  );
  const height = Math.max(20 + headingHeight + 6 + linesHeight + 14, badgeSize + 28);

  doc.roundedRect(opts.x, opts.y, opts.width, height, 6).fill(INK.panelFill);
  drawIconBadge(doc, opts.icon, opts.x + 14, opts.y + 14, badgeSize, '#ffffff', INK.heading);

  let y = opts.y + 14;
  doc
    .font(FONT_BOLD)
    .fillColor(INK.faint)
    .fontSize(8)
    .text(opts.label, textX, y, { width: innerWidth });
  y = doc.y + 4;

  doc
    .font(FONT_BOLD)
    .fillColor(INK.heading)
    .fontSize(11)
    .text(opts.heading, textX, y, { width: innerWidth });
  y = doc.y + 3;

  doc.font(FONT_SANS).fillColor(INK.body).fontSize(9);
  opts.lines.forEach((line) => {
    doc.text(line, textX, y, { width: innerWidth });
    y = doc.y + 3;
  });

  return opts.y + height;
}

/** A full-width light-grey band with an icon and a bold label — "PAYMENT SUMMARY". */
export function drawSectionBar(
  doc: InstanceType<typeof PDFDocument>,
  y: number,
  icon: IconName,
  label: string,
): number {
  const height = 34;
  doc.roundedRect(PAGE.margin, y, PAGE.contentRight - PAGE.margin, height, 6).fill(INK.panelFill);
  drawIconBadge(doc, icon, PAGE.margin + 10, y + 5, 24, '#ffffff', INK.heading);
  doc
    .font(FONT_BOLD)
    .fillColor(INK.heading)
    .fontSize(10)
    .text(label, PAGE.margin + 46, y + 12, { width: PAGE.contentRight - PAGE.margin - 56 });

  return y + height;
}

const COLS = {
  description: { x: 50, width: 175 },
  qty: { x: 225, width: 35 },
  rate: { x: 260, width: 80 },
  taxable: { x: 340, width: 85 },
  gst: { x: 425, width: 35 },
  amount: { x: 460, width: 85 },
};
const ROW_PAD_TOP = 8;
const ROW_PAD_BOTTOM = 10;

/** The invoice/receipt line-item table — description, qty, rate, taxable value, GST%, amount. */
export function drawLineItemsTable(
  doc: InstanceType<typeof PDFDocument>,
  startY: number,
  items: LineItem[],
  currency: string,
): number {
  let y = startY;
  doc.font(FONT_BOLD).fillColor(INK.faint).fontSize(8);
  doc.text('DESCRIPTION', COLS.description.x, y, { width: COLS.description.width });
  doc.text('QTY', COLS.qty.x, y, { width: COLS.qty.width, align: 'right' });
  doc.text('RATE', COLS.rate.x, y, { width: COLS.rate.width, align: 'right' });
  doc.text('TAXABLE VALUE', COLS.taxable.x, y, { width: COLS.taxable.width, align: 'right' });
  doc.text('GST%', COLS.gst.x, y, { width: COLS.gst.width, align: 'right' });
  doc.text('AMOUNT', COLS.amount.x, y, { width: COLS.amount.width, align: 'right' });
  y += 16;
  doc.moveTo(PAGE.margin, y).lineTo(PAGE.contentRight, y).strokeColor(INK.ruleStrong).stroke();
  y += 10;

  items.forEach((item) => {
    const rowTop = y;
    const taxableValue = (Number(item.quantity) * Number(item.unit_price)).toFixed(2);

    doc.font(FONT_SANS).fontSize(9);
    const descHeight = doc.heightOfString(item.description, { width: COLS.description.width });
    const rowHeight = Math.max(descHeight, 11) + ROW_PAD_TOP + ROW_PAD_BOTTOM;

    doc.fillColor(INK.body);
    doc.text(item.description, COLS.description.x, rowTop + ROW_PAD_TOP, {
      width: COLS.description.width,
    });
    doc.text(item.quantity, COLS.qty.x, rowTop + ROW_PAD_TOP, {
      width: COLS.qty.width,
      align: 'right',
    });
    doc.text(money(item.unit_price, currency), COLS.rate.x, rowTop + ROW_PAD_TOP, {
      width: COLS.rate.width,
      align: 'right',
    });
    doc.text(money(taxableValue, currency), COLS.taxable.x, rowTop + ROW_PAD_TOP, {
      width: COLS.taxable.width,
      align: 'right',
    });
    doc.text(`${item.tax_rate}%`, COLS.gst.x, rowTop + ROW_PAD_TOP, {
      width: COLS.gst.width,
      align: 'right',
    });
    doc.text(money(item.line_total, currency), COLS.amount.x, rowTop + ROW_PAD_TOP, {
      width: COLS.amount.width,
      align: 'right',
    });

    y = rowTop + rowHeight;
    doc.moveTo(PAGE.margin, y).lineTo(PAGE.contentRight, y).strokeColor(INK.rule).stroke();
  });

  return y + 20;
}

/** Subtotal / GST / Grand total — the grand total sits inside a filled highlight band. */
export function drawSummary(
  doc: InstanceType<typeof PDFDocument>,
  startY: number,
  subtotal: string,
  taxAmount: string,
  total: string,
  currency: string,
): number {
  const labelX = 340;
  const valueX = COLS.amount.x;
  const valueWidth = PAGE.contentRight - valueX;
  const labelWidth = valueX - labelX - 10;
  let y = startY;

  const row = (label: string, value: string) => {
    doc.font(FONT_SANS).fillColor(INK.body).fontSize(10);
    doc.text(label, labelX, y, { width: labelWidth });
    doc.text(value, valueX, y, { width: valueWidth, align: 'right' });
    y = doc.y + 14;
  };

  row('Subtotal', money(subtotal, currency));
  row('GST', money(taxAmount, currency));

  const barTop = y;
  const barHeight = 32;
  doc.roundedRect(labelX, barTop, PAGE.contentRight - labelX, barHeight, 6).fill(INK.highlightFill);
  doc
    .font(FONT_BOLD)
    .fillColor(INK.heading)
    .fontSize(11)
    .text('GRAND TOTAL', labelX + 12, barTop + 11, { width: labelWidth });
  doc.text(money(total, currency), valueX, barTop + 11, { width: valueWidth - 12, align: 'right' });

  return barTop + barHeight + 24;
}

/** A bordered box with an icon — "Thank you for your business", the disclaimer, etc. */
export function drawNoticeBox(
  doc: InstanceType<typeof PDFDocument>,
  y: number,
  icon: IconName,
  heading: string,
  body: string,
): number {
  const iconSize = 28;
  const textX = PAGE.margin + iconSize + 14;
  const textWidth = PAGE.contentRight - textX - 12;

  doc.font(FONT_BOLD).fontSize(9.5);
  const headingHeight = doc.heightOfString(heading, { width: textWidth });
  doc.font(FONT_SANS).fontSize(9);
  const bodyHeight = doc.heightOfString(body, { width: textWidth });
  const height = Math.max(20 + headingHeight + 3 + bodyHeight + 16, iconSize + 24);

  doc
    .roundedRect(PAGE.margin, y, PAGE.contentRight - PAGE.margin, height, 6)
    .strokeColor(INK.rule)
    .stroke();
  drawIcon(doc, icon, PAGE.margin + 12, y + 12, iconSize, INK.muted);

  let textY = y + 14;
  doc
    .font(FONT_BOLD)
    .fillColor(INK.heading)
    .fontSize(9.5)
    .text(heading, textX, textY, { width: textWidth });
  textY = doc.y + 3;
  doc
    .font(FONT_SANS)
    .fillColor(INK.muted)
    .fontSize(9)
    .text(body, textX, textY, { width: textWidth });

  return y + height + 20;
}

/** The box an uploaded signature is fitted into, above the "Authorised Signatory" line. */
const SIGNATURE_BOX = { width: 130, height: 32, gap: 6 };

export function drawFooter(
  doc: InstanceType<typeof PDFDocument>,
  org: OrgInfo,
  /**
   * The uploaded signature image (System Settings → Organisation), or null when
   * the association has not uploaded one. Absent, the footer keeps the pen glyph
   * it has always drawn: the line says who signs, and nothing pretends they did.
   */
  signature?: Buffer | null,
): void {
  const y = doc.page.height - doc.page.margins.bottom - 34;

  // Read BEFORE anything below writes: the footer's own text moves the cursor
  // into the footer band, and asking afterwards asks where the footer is, not
  // where the document's content ended.
  const contentBottom = doc.y;

  doc.moveTo(PAGE.margin, y).lineTo(PAGE.contentRight, y).strokeColor(INK.rule).stroke();

  const iconSize = 16;
  drawIcon(doc, 'mail', PAGE.margin, y + 12, iconSize, INK.faint);
  doc
    .font(FONT_SANS)
    .fillColor(INK.faint)
    .fontSize(8)
    .text(
      org.support_email ? `${org.name} · ${org.support_email}` : org.name,
      PAGE.margin + iconSize + 6,
      y + 15,
      { width: 300 },
    );

  /*
    The image goes ABOVE the rule, in the space the last block of content left
    behind — which is why it is conditional on there being any. A signature
    printed over a line item is worse than no signature at all, so on a page
    that runs to the bottom the footer silently keeps its text-only form.
  */
  const signatureTop = y - SIGNATURE_BOX.height - SIGNATURE_BOX.gap;
  const fits = signature != null && contentBottom < signatureTop;

  if (fits) {
    doc.image(signature as Buffer, PAGE.contentRight - SIGNATURE_BOX.width, signatureTop, {
      fit: [SIGNATURE_BOX.width, SIGNATURE_BOX.height],
      align: 'right',
      valign: 'bottom',
    });
  }

  const signatoryText = 'Authorised Signatory';
  doc.font(FONT_SANS).fontSize(9);
  const signatoryWidth = doc.widthOfString(signatoryText);

  if (fits) {
    // No pen glyph beside a real signature — the drawing of a pen next to the
    // thing it stands in for reads as clip art, not as a second signature.
    doc.fillColor(INK.muted).text(signatoryText, PAGE.contentRight - signatoryWidth, y + 13, {
      width: signatoryWidth + 2,
    });

    return;
  }

  const signatoryIconX = PAGE.contentRight - signatoryWidth - iconSize - 6;
  drawIcon(doc, 'penLine', signatoryIconX, y + 11, iconSize, INK.muted);
  doc
    .fillColor(INK.muted)
    .text(signatoryText, signatoryIconX + iconSize + 6, y + 13, { width: signatoryWidth + 2 });
}
