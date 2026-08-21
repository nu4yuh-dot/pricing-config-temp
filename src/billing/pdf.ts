/**
 * A very small PDF writer.
 *
 * Written rather than depended on. This service has seven runtime dependencies and
 * hand-writes its repositories; a statement is a page of text and ruled lines, and pulling
 * in a document toolkit to draw them would be the largest dependency here by an order of
 * magnitude. What this does not do is everything else a PDF can: no images, no embedded
 * fonts, no wrapping. It draws text at coordinates in one of the base-14 fonts, and rules
 * lines. That is the whole surface, and it is enough for a statement.
 *
 * Two consequences worth stating because they are not obvious:
 *
 *  - **Helvetica is WinAnsi**, which has no rupee sign. `₹` would emit as a wrong glyph or
 *    nothing at all, so amounts are written `Rs.` — a document that shows the wrong currency
 *    symbol on a bill is worse than one that spells it.
 *  - **Nothing wraps.** A caller passing a long string gets a long line, off the page if it
 *    is long enough. Text is truncated at the call site where the column width is known,
 *    rather than here where it is not.
 */

export const PAGE = { width: 595.28, height: 841.89 } as const; // A4 in points

export type Font = 'Helvetica' | 'Helvetica-Bold' | 'Courier';

interface TextOp {
  kind: 'text';
  x: number;
  y: number;
  size: number;
  font: Font;
  value: string;
}

interface LineOp {
  kind: 'line';
  from: [number, number];
  to: [number, number];
  width: number;
  grey: number;
}

export type Op = TextOp | LineOp;

/**
 * Escape what PDF string syntax reserves.
 *
 * A customer legal name containing a bracket — "Mahle (India)" — would otherwise close the
 * string early and corrupt every object after it, which is a file no reader opens rather
 * than a page with a typo.
 */
function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Drop what WinAnsi cannot represent.
 *
 * Rupee signs, em dashes and smart quotes all reach here from data typed by people. Mapped
 * where there is an obvious equivalent and dropped where there is not, because a byte the
 * reader cannot decode can break the glyph run around it.
 */
function toWinAnsi(value: string): string {
  return value
    .replace(/₹/g, 'Rs.')
    .replace(/[–—]/g, '-')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/→/g, '->')
    .replace(/·/g, '-')
    // Anything still outside the printable Latin-1 range would be a wrong glyph, not a
    // missing one, so it goes.
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}

export class Page {
  readonly ops: Op[] = [];

  text(x: number, y: number, value: string, options: { size?: number; font?: Font } = {}): this {
    this.ops.push({
      kind: 'text',
      x,
      // Callers think top-down; PDF counts from the bottom. Converted here so no caller has
      // to remember which way up the page is.
      y: PAGE.height - y,
      size: options.size ?? 9,
      font: options.font ?? 'Helvetica',
      value: toWinAnsi(value),
    });
    return this;
  }

  /** Right-aligned, for money. Helvetica's widths are approximated at 0.5em per character. */
  textRight(right: number, y: number, value: string, options: { size?: number; font?: Font } = {}): this {
    const size = options.size ?? 9;
    const width = toWinAnsi(value).length * size * 0.5;
    return this.text(right - width, y, value, options);
  }

  rule(y: number, from = 42, to = PAGE.width - 42, grey = 0.75, width = 0.5): this {
    this.ops.push({
      kind: 'line',
      from: [from, PAGE.height - y],
      to: [to, PAGE.height - y],
      width,
      grey,
    });
    return this;
  }
}

const FONT_IDS: Record<Font, string> = {
  Helvetica: '/F1',
  'Helvetica-Bold': '/F2',
  Courier: '/F3',
};

function contentStream(page: Page): string {
  const parts: string[] = [];
  for (const op of page.ops) {
    if (op.kind === 'line') {
      parts.push(
        `${op.grey} G ${op.width} w ${op.from[0]} ${op.from[1]} m ${op.to[0]} ${op.to[1]} l S`,
      );
    } else {
      parts.push(
        `BT ${FONT_IDS[op.font]} ${op.size} Tf ${op.x} ${op.y} Td (${escapeText(op.value)}) Tj ET`,
      );
    }
  }
  return parts.join('\n');
}

/**
 * Assemble the pages into a PDF file.
 *
 * Offsets are counted as the objects are written rather than computed in advance: the xref
 * table has to say exactly where each object starts, and a table that disagrees with the
 * body by one byte produces a file that some readers open and others refuse.
 */
export function renderPdf(pages: readonly Page[], title: string): Buffer {
  if (pages.length === 0) throw new Error('A PDF needs at least one page.');

  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  objects.push(
    '<< /Font << ' +
      '/F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> ' +
      '/F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >> ' +
      '/F3 << /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >> ' +
      '>> >>',
  );

  pages.forEach((page, index) => {
    const contentId = pageIds[index]! + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /Resources 3 0 R ` +
        `/MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Contents ${contentId} 0 R >>`,
    );
    const stream = contentStream(page);
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });

  objects.push(
    `<< /Title (${escapeText(toWinAnsi(title))}) /Producer (DNS Logistics pricing service) >>`,
  );
  const infoId = objects.length;

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefAt = Buffer.byteLength(body, 'latin1');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(body + xref, 'latin1');
}
