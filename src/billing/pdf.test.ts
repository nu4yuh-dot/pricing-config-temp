import { describe, expect, test } from 'vitest';
import { Page, renderPdf, PAGE } from './pdf';

const read = (buffer: Buffer) => buffer.toString('latin1');

describe('the file a reader has to open', () => {
  test('it is a PDF, and it ends where a PDF ends', () => {
    const pdf = read(renderPdf([new Page().text(40, 40, 'Hello')], 'Test'));
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  test('every offset in the xref table points at the object it claims', () => {
    // A table that disagrees with the body by one byte gives a file some readers open and
    // others refuse, which is the worst kind of broken: it looks fine until it does not.
    const pdf = read(renderPdf([new Page().text(40, 40, 'Hello'), new Page().text(40, 40, 'Two')], 'Test'));
    // `lastIndexOf('xref')` finds the tail of `startxref`, not the table — the table is
    // the one that starts its own line.
    const table = pdf.slice(pdf.indexOf('\nxref\n'));
    const offsets = [...table.matchAll(/^(\d{10}) 00000 n/gm)].map((m) => Number(m[1]));
    expect(offsets.length).toBeGreaterThan(4);
    offsets.forEach((offset, index) => {
      expect(pdf.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });
  });

  test('startxref points at the xref table itself', () => {
    const pdf = read(renderPdf([new Page().text(40, 40, 'Hello')], 'Test'));
    const declared = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(declared, declared + 4)).toBe('xref');
  });

  test('a page count of zero is refused rather than written', () => {
    expect(() => renderPdf([], 'Test')).toThrow(/at least one page/i);
  });

  test('each page declares A4 and its own content stream', () => {
    const pdf = read(renderPdf([new Page(), new Page()], 'Test'));
    expect([...pdf.matchAll(/\/Type \/Page[^s]/g)]).toHaveLength(2);
    expect(pdf).toContain(`/MediaBox [0 0 ${PAGE.width} ${PAGE.height}]`);
    expect(pdf).toContain('/Count 2');
  });

  test('a declared stream length matches the bytes that follow it', () => {
    // A length that overstates runs the parser into the next object.
    const pdf = read(renderPdf([new Page().text(40, 40, 'Hello there')], 'Test'));
    const match = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(pdf)!;
    expect(Buffer.byteLength(match[2]!, 'latin1')).toBe(Number(match[1]));
  });
});

describe('text that would break the file', () => {
  test('brackets in a name are escaped, not left to close the string early', () => {
    // "Mahle (India)" would otherwise end the string and corrupt every object after it.
    const pdf = read(renderPdf([new Page().text(40, 40, 'Mahle (India) Pvt')], 'Test'));
    expect(pdf).toContain('Mahle \\(India\\) Pvt');
  });

  test('a backslash is escaped before the brackets are', () => {
    const pdf = read(renderPdf([new Page().text(40, 40, 'a\\b(c)')], 'Test'));
    expect(pdf).toContain('a\\\\b\\(c\\)');
  });

  test('the rupee sign becomes Rs., because the font has no glyph for it', () => {
    // A wrong currency symbol on a bill is worse than a spelled one.
    const pdf = read(renderPdf([new Page().text(40, 40, '₹1,234.00')], 'Test'));
    expect(pdf).toContain('Rs.1,234.00');
    expect(pdf).not.toContain('₹');
  });

  test('typographic characters that people paste in are mapped, not dropped mid-word', () => {
    const pdf = read(renderPdf([new Page().text(40, 40, 'Mahle’s — NCR → BOM')], 'Test'));
    expect(pdf).toContain("Mahle's - NCR -> BOM");
  });

  test('a character with no Latin-1 equivalent is removed rather than emitted wrong', () => {
    const pdf = read(renderPdf([new Page().text(40, 40, 'ok 日本 ok')], 'Test'));
    expect(pdf).toContain('ok  ok');
  });

  test('the title is escaped too, since it comes from the same data', () => {
    const pdf = read(renderPdf([new Page()], 'Statement (Jul 2026)'));
    expect(pdf).toContain('/Title (Statement \\(Jul 2026\\))');
  });
});

describe('drawing', () => {
  test('callers place text from the top, and the file records it from the bottom', () => {
    // Nobody should have to remember which way up a PDF counts.
    const page = new Page().text(42, 100, 'x');
    expect(page.ops[0]).toMatchObject({ y: PAGE.height - 100 });
  });

  test('a rule is a stroked line at the width given', () => {
    const pdf = read(renderPdf([new Page().rule(120)], 'Test'));
    expect(pdf).toMatch(/0\.75 G 0\.5 w 42 [\d.]+ m [\d.]+ [\d.]+ l S/);
  });

  test('right-aligned text is placed left of the margin it is aligned to', () => {
    const page = new Page().textRight(500, 100, '1,234.00', { size: 9 });
    const op = page.ops[0] as { x: number };
    expect(op.x).toBeLessThan(500);
    expect(op.x).toBeGreaterThan(400);
  });
});
