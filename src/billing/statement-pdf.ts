import { Page, PAGE, renderPdf } from './pdf';
import type { CustomerBill } from './statement';

/**
 * A period's charges, as a page somebody can send on.
 *
 * **Deliberately a statement and not a tax invoice.** The portal asks for
 * `bill/{cycleId}/pdf` — a cycle, and a cycle holds several invoice numbers because this
 * system raises one invoice per customer per mode. A tax invoice is one document with one
 * number, so a cycle-scoped PDF is a summary that references them.
 *
 * The other reason is harder. A GST tax invoice must carry the supplier's registered name,
 * address and GSTIN, and the place of supply. **None of that is held anywhere in this
 * service** — there is no record of our own registration — so rendering one would mean
 * printing a GSTIN somebody made up, on a tax document. A statement carries no such claim:
 * it says what was charged and names the invoices that charged it, and the tax invoices
 * remain the tax invoices.
 *
 * The header says so on the page, so nobody files it as something it is not.
 */

const LEFT = 42;
const RIGHT = PAGE.width - 42;
const ROWS_PER_PAGE = 34;

const rupees = (paise: number) =>
  `Rs. ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const day = (date: Date) =>
  date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

/** Cut a value to a column, with an ellipsis so a reader knows it was cut. */
function fit(value: string, characters: number): string {
  return value.length <= characters ? value : `${value.slice(0, characters - 1)}...`;
}

function header(page: Page, bill: CustomerBill, customerName: string, pageNumber: number, pages: number): number {
  page.text(LEFT, 52, 'DNS LOGISTICS', { size: 13, font: 'Helvetica-Bold' });
  page.textRight(RIGHT, 52, 'STATEMENT OF CHARGES', { size: 10, font: 'Helvetica-Bold' });
  page.rule(58, LEFT, RIGHT, 0.55, 0.8);

  page.text(LEFT, 76, customerName, { size: 11, font: 'Helvetica-Bold' });
  page.text(LEFT, 90, `${day(bill.from)} to ${day(bill.to)}`, { size: 9 });
  page.textRight(RIGHT, 76, `Period ${bill.periodId}`, { size: 9 });
  page.textRight(RIGHT, 90, bill.dueAt ? `Due ${day(bill.dueAt)}` : 'No due date set', { size: 9 });
  if (pages > 1) page.textRight(RIGHT, 104, `Page ${pageNumber} of ${pages}`, { size: 8 });

  let y = 118;
  page.text(LEFT, y, 'Tax invoices in this period', { size: 8, font: 'Helvetica-Bold' });
  y += 12;
  for (const number of bill.invoiceNumbers) {
    page.text(LEFT + 8, y, number, { size: 8, font: 'Courier' });
    y += 11;
  }
  if (bill.invoiceNumbers.length === 0) {
    page.text(LEFT + 8, y, 'None — this period has not been billed.', { size: 8 });
    y += 11;
  }

  y += 6;
  page.rule(y, LEFT, RIGHT, 0.75);
  y += 12;
  page.text(LEFT, y, 'AWB', { size: 7.5, font: 'Helvetica-Bold' });
  page.text(LEFT + 78, y, 'DATE', { size: 7.5, font: 'Helvetica-Bold' });
  page.text(LEFT + 128, y, 'LANE', { size: 7.5, font: 'Helvetica-Bold' });
  page.text(LEFT + 236, y, 'MODE', { size: 7.5, font: 'Helvetica-Bold' });
  page.textRight(LEFT + 300, y, 'KG', { size: 7.5, font: 'Helvetica-Bold' });
  page.textRight(LEFT + 372, y, 'TAXABLE', { size: 7.5, font: 'Helvetica-Bold' });
  page.textRight(LEFT + 428, y, 'GST', { size: 7.5, font: 'Helvetica-Bold' });
  page.textRight(RIGHT, y, 'TOTAL', { size: 7.5, font: 'Helvetica-Bold' });
  y += 4;
  page.rule(y, LEFT, RIGHT, 0.75);
  return y + 13;
}

function totals(page: Page, bill: CustomerBill, y: number): void {
  page.rule(y, LEFT + 300, RIGHT, 0.6, 0.8);
  let at = y + 14;

  const row = (label: string, value: string, bold = false) => {
    const font = bold ? ('Helvetica-Bold' as const) : ('Helvetica' as const);
    page.text(LEFT + 300, at, label, { size: 9, font });
    page.textRight(RIGHT, at, value, { size: 9, font });
    at += 14;
  };

  row('Charged', rupees(bill.totalPaise));
  row('Received', rupees(bill.paidPaise));
  row('Outstanding', rupees(bill.balancePaise), true);

  if (bill.disputedCount > 0) {
    at += 4;
    page.text(LEFT, at, `${bill.disputedCount} line(s) disputed, ${rupees(bill.disputedPaise)} — under review.`, { size: 8 });
    at += 12;
  }
  if (bill.restatedByPaise !== undefined && bill.restatedByPaise !== 0) {
    page.text(LEFT, at, `This period was reopened and corrected by ${rupees(bill.restatedByPaise)} since it was first billed.`, { size: 8 });
    at += 12;
  }

  page.rule(PAGE.height - 58, LEFT, RIGHT, 0.85, 0.4);
  page.text(
    LEFT,
    PAGE.height - 46,
    'This is a statement of charges, not a tax invoice. The tax invoices are the numbered documents listed above.',
    { size: 7.5 },
  );
}

/** The statement, paginated so a long period does not run off the page. */
export function renderStatement(bill: CustomerBill, customerName: string): Buffer {
  const chunks: CustomerBill['lines'][] = [];
  for (let i = 0; i < bill.lines.length; i += ROWS_PER_PAGE) {
    chunks.push(bill.lines.slice(i, i + ROWS_PER_PAGE));
  }
  // A period with nothing in it is still a statement — saying "no charges" is an answer,
  // and an empty file is not.
  if (chunks.length === 0) chunks.push([]);

  const pages = chunks.map((lines, index) => {
    const page = new Page();
    let y = header(page, bill, customerName, index + 1, chunks.length);

    if (lines.length === 0) {
      page.text(LEFT, y, 'No charges in this period.', { size: 9 });
      y += 16;
    }

    for (const line of lines) {
      page.text(LEFT, y, fit(line.reference, 15), { size: 8, font: 'Courier' });
      page.text(LEFT + 78, y, day(line.date), { size: 8 });
      page.text(LEFT + 128, y, fit(`${line.origin} -> ${line.destination}`, 24), { size: 8 });
      page.text(LEFT + 236, y, fit(line.mode, 10), { size: 8 });
      page.textRight(LEFT + 300, y, String(line.chargeableWeight), { size: 8 });
      page.textRight(LEFT + 372, y, (line.taxableValuePaise / 100).toFixed(2), { size: 8 });
      page.textRight(LEFT + 428, y, (line.gstPaise / 100).toFixed(2), { size: 8 });
      page.textRight(RIGHT, y, (line.totalPaise / 100).toFixed(2), { size: 8 });
      if (line.reconciliation === 'disputed') {
        page.text(LEFT + 8, y + 9, `disputed: ${fit(line.disputeReason ?? 'no reason given', 70)}`, { size: 7 });
        y += 9;
      }
      y += 13;
    }

    // Totals only on the last page: a running total on page one that disagrees with the
    // final figure is how somebody pays the wrong amount.
    if (index === chunks.length - 1) totals(page, bill, y + 4);
    return page;
  });

  return renderPdf(pages, `Statement ${bill.periodId} - ${customerName}`);
}
