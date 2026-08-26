import type PDFDocument from 'pdfkit';

/**
 * Icon glyphs used on the invoice and receipt PDFs, drawn with pdfkit's
 * vector primitives rather than a font — pdfkit has no icon-font renderer,
 * and embedding one is the same class of risk the Geist font already hit.
 *
 * The shapes themselves are not invented: each `d`/`cx,cy,r`/`rect` below is
 * copied verbatim from `lucide-react` (ISC licensed), the exact icon set the
 * admin app already renders with (`DocumentVerificationDrawer.tsx` etc.),
 * on its standard 24×24 viewBox, 2px stroke, round caps/joins.
 */

type IconShape =
  | { type: 'path'; d: string }
  | { type: 'circle'; cx: number; cy: number; r: number }
  | { type: 'rect'; x: number; y: number; width: number; height: number; rx?: number };

export const ICONS: Record<string, IconShape[]> = {
  user: [
    { type: 'path', d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' },
    { type: 'circle', cx: 12, cy: 7, r: 4 },
  ],
  fileText: [
    {
      type: 'path',
      d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
    },
    { type: 'path', d: 'M14 2v5a1 1 0 0 0 1 1h5' },
    { type: 'path', d: 'M10 9H8' },
    { type: 'path', d: 'M16 13H8' },
    { type: 'path', d: 'M16 17H8' },
  ],
  receipt: [
    { type: 'path', d: 'M12 17V7' },
    { type: 'path', d: 'M16 8h-6a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H8' },
    {
      type: 'path',
      d: 'M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z',
    },
  ],
  wallet: [
    {
      type: 'path',
      d: 'M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1',
    },
    { type: 'path', d: 'M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4' },
  ],
  shieldCheck: [
    {
      type: 'path',
      d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
    },
    { type: 'path', d: 'm9 12 2 2 4-4' },
  ],
  mail: [
    { type: 'path', d: 'm22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7' },
    { type: 'rect', x: 2, y: 4, width: 20, height: 16, rx: 2 },
  ],
  penLine: [
    { type: 'path', d: 'M13 21h8' },
    {
      type: 'path',
      d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    },
  ],
};

export type IconName = keyof typeof ICONS;

/**
 * Draws one icon centred inside a `size`×`size` box at (x, y), scaled from
 * its native 24×24 viewBox. Stroke-only, matching Lucide's own style —
 * these are line icons, not filled glyphs.
 */
export function drawIcon(
  doc: InstanceType<typeof PDFDocument>,
  name: IconName,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  const scale = size / 24;

  doc.save();
  doc.translate(x, y).scale(scale);
  doc
    .lineWidth(2 / scale)
    .strokeColor(color)
    .lineCap('round')
    .lineJoin('round');

  ICONS[name].forEach((shape) => {
    if (shape.type === 'path') {
      doc.path(shape.d).stroke();
    } else if (shape.type === 'circle') {
      doc.circle(shape.cx, shape.cy, shape.r).stroke();
    } else {
      if (shape.rx) {
        doc.roundedRect(shape.x, shape.y, shape.width, shape.height, shape.rx).stroke();
      } else {
        doc.rect(shape.x, shape.y, shape.width, shape.height).stroke();
      }
    }
  });

  doc.restore();
}

/** A light-grey circle with an icon centred inside it — the badge every panel and footer line uses. */
export function drawIconBadge(
  doc: InstanceType<typeof PDFDocument>,
  name: IconName,
  x: number,
  y: number,
  diameter: number,
  fill: string,
  stroke: string,
): void {
  doc.circle(x + diameter / 2, y + diameter / 2, diameter / 2).fill(fill);
  const iconSize = diameter * 0.5;
  drawIcon(
    doc,
    name,
    x + (diameter - iconSize) / 2,
    y + (diameter - iconSize) / 2,
    iconSize,
    stroke,
  );
}
