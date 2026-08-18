import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUser } from '../../../../../auth/session';
import { can } from '../../../../../auth/roles';
import { canEditDraft } from '../../../../../data/workflow';
import { draftVersion, findCard } from '../../../../../data/rate-cards';
import UpsCardEditor from '../../../../../components/console/UpsCardEditor';

/**
 * The UPS card, on screen and editable.
 *
 * This tariff has no spreadsheet tabs, so the sheet walk that builds the approval diff is
 * blind to it. `changes/ups-diff.ts` is what closes that: every field below produces a
 * labelled review line, and `changes/ups-diff.test.ts` is what stops the next person
 * adding a field that quietly does not.
 *
 * Edits land in the draft like any other cell and reach production only after approval.
 */
export default async function UpsCardPage({ params }: { params: Promise<{ card: string }> }) {
  const { card: cardKey } = await params;
  const user = await currentUser();
  if (!user) notFound();

  const card = await findCard(cardKey);
  if (!card) notFound();

  const draft = await draftVersion(cardKey);
  const data = draft.data.ups;
  if (!data) notFound();

  const frozen = !canEditDraft(draft.state);
  const canEdit = can(user.role, 'edit-draft') && !frozen;

  const money = (n: number) =>
    n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const byZone: Record<string, number> = {};
  for (const zone of Object.values(data.zones)) byZone[zone] = (byZone[zone] ?? 0) + 1;

  return (
    <>
      <h2>UPS / MOVIN — international export</h2>
      <p className="lede">
        Ex-{data.params.origin}. The signed agreement priced by destination country, with three
        products and a surge fee that follows a world region rather than the rate zone. Read-only
        here: this tariff has no spreadsheet tabs yet, so an edit would move a price without
        producing a line for an approver to read.
      </p>

      <div className="callout info">
        <strong>Rebuilt from the workbook, or edited here</strong>
        <code>python3 scripts/extract_ups.py</code> reads the approved rate card and the
        calculator, then <code>npx tsx scripts/build-ups-card.ts</code> wraps it — that is how the
        card was first loaded. Editing below writes to the draft and goes through approval like
        every other rate in this system.
        {frozen && ' This draft is with an approver, so it is read-only until they decide.'}
      </div>

      <UpsCardEditor cardKey={cardKey} data={data} canEdit={canEdit} />

      <h3>Destinations and zones</h3>
      <p style={{ color: 'var(--ink-soft)', fontSize: 12, marginTop: 0 }}>
        A destination with no surge region of its own falls to{' '}
        <strong>{data.defaultSurgeRegion}</strong>. Rebuild from the workbook to change which
        country sits in which zone.
      </p>

      <h3>Destinations by rate zone</h3>
      <div className="scroll-x">
        <table className="data">
          <thead>
            <tr><th>Zone</th><th className="num">Destinations</th><th>Envelope</th><th>0.5 kg package</th><th>20 kg package</th></tr>
          </thead>
          <tbody>
            {data.zoneKeys.map((zone) => (
              <tr key={zone}>
                <td><strong>{zone}</strong></td>
                <td className="num">{byZone[zone] ?? 0}</td>
                <td className="num">{data.rates.envelope[zone] === undefined ? '—' : money(data.rates.envelope[zone]!)}</td>
                <td className="num">
                  {data.rates.package[0]?.rates[zone] === undefined ? '—' : money(data.rates.package[0]!.rates[zone]!)}
                </td>
                <td className="num">
                  {data.rates.package.at(-1)?.rates[zone] === undefined
                    ? '—'
                    : money(data.rates.package.at(-1)!.rates[zone]!)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ color: 'var(--ink-soft)', fontSize: 12 }}>
        {data.rates.document.length} document steps to {data.rates.document.at(-1)?.toKg} kg,{' '}
        {data.rates.package.length} package steps to {data.rates.package.at(-1)?.toKg} kg, then{' '}
        {data.rates.bulk.length} per-kilogram bands.
        {data.unserved.length > 0 && ` Not served: ${data.unserved.join(', ')}.`}
      </p>

      <p style={{ color: 'var(--ink-soft)', fontSize: 12 }}>
        Price a shipment on <Link href="/ups">the UPS calculator</Link>.
      </p>
    </>
  );
}
