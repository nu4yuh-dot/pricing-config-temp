'use client';

import { useState, useTransition } from 'react';
import { editChargeEverywhere } from '../../app/console-actions';
import { useToast } from '../Toasts';
import type { ChargePlace } from '../../domain/charge-library';

/**
 * One row of the charge library, and the editor it opens.
 *
 * The whole row is a client component so the editor can be a **full-width row underneath**
 * rather than a panel crammed into a table cell. That is the only reason the presentational
 * markup lives here rather than on the page.
 *
 * The library is derived from what every card and contract declares, so a row is not one
 * record — "handling · 5 places" is five separate per-card cell sets. The editor therefore
 * makes scope the first thing you choose and names the cards, instead of an Edit button that
 * silently picks one of the five.
 *
 * Two things it states rather than hides. **Each card is approved separately**, because a
 * card's draft and its change request belong to that card — one request spanning five would
 * take the decision away from four of the people who own them. And **contracts are left
 * alone**: a customer who negotiated their own version of a charge keeps it, which is the
 * point of having negotiated it.
 */
export default function ChargeRow(props: {
  chargeId: string;
  name: string;
  basis: string;
  basisLabel: string;
  gstApplies: boolean;
  fuelApplies: boolean;
  bookableOneOff: boolean;
  /** Already resolved by `isBookableOneOff`, so the chip and the editor cannot disagree. */
  offeredOneOff: boolean;
  places: ChargePlace[];
  canEdit: boolean;
  columns: number;
}) {
  const cards = props.places.filter((place) => place.kind === 'card');
  const contracts = props.places.filter((place) => place.kind === 'contract');
  const oneOffPossible = props.basis !== 'per-destination' && props.basis !== 'by-pincode';

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(props.name);
  const [gst, setGst] = useState(props.gstApplies);
  const [fuel, setFuel] = useState(props.fuelApplies);
  const [oneOff, setOneOff] = useState(props.bookableOneOff);
  const [chosen, setChosen] = useState<string[]>(cards.map((card) => card.key));
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  const toggle = (key: string) =>
    setChosen((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );

  const save = () =>
    startTransition(async () => {
      const outcome = await editChargeEverywhere({
        chargeId: props.chargeId,
        cardKeys: chosen,
        name,
        gstApplies: gst,
        fuelApplies: fuel,
        ...(oneOffPossible ? { bookableOneOff: oneOff } : {}),
      });

      if ('error' in outcome) {
        toast.failed('change that charge', outcome.error);
        return;
      }
      const count = outcome.changed.length;
      toast.saved(
        props.name,
        `Into the draft on ${count} card${count === 1 ? '' : 's'}. ` +
          `${count === 1 ? 'It needs' : 'Each needs'} approving separately.`,
      );
      setOpen(false);
    });

  return (
    <>
      <tr>
        <td>
          <strong>{props.name}</strong>
        </td>
        <td className="ref">{props.chargeId}</td>
        <td>{props.basisLabel}</td>
        {/* Only the exception is worth a chip. Marking every charge "in GST" when almost all
            of them are put six identical badges on the screen and made the one that is not
            harder to spot, not easier. */}
        <td>
          {props.gstApplies ? (
            <span className="meta">in GST</span>
          ) : (
            <span className="chip pending">outside GST</span>
          )}
        </td>
        <td>
          {props.fuelApplies ? <span className="chip">applies</span> : <span className="meta">—</span>}
        </td>
        <td>
          {props.offeredOneOff ? (
            <span className="chip live">bookable</span>
          ) : (
            <span className="meta">standing term only</span>
          )}
        </td>
        <td>
          {props.places.length === 0 ? (
            <span className="meta">not used</span>
          ) : (
            <>
              {cards.map((entry, index) => (
                <span key={entry.key}>
                  {index > 0 && ', '}
                  <a href={`/console/${entry.key}/tax`}>{entry.label}</a>
                </span>
              ))}
              {contracts.length > 0 && (
                <span className="meta" title={contracts.map((entry) => entry.label).join(', ')}>
                  {cards.length > 0 && ' · '}
                  {contracts.length} negotiated
                </span>
              )}
            </>
          )}
        </td>
        <td>
          {props.canEdit && cards.length > 0 ? (
            <button type="button" className="linklike" onClick={() => setOpen(!open)}>
              {open ? 'Close' : 'Edit'}
            </button>
          ) : (
            <span className="meta">—</span>
          )}
        </td>
      </tr>

      {open && (
        <tr>
          <td colSpan={props.columns} style={{ background: 'var(--paper-sunk)' }}>
            <div className="inline-form">
              <div className="field" style={{ minWidth: 180 }}>
                <label htmlFor={`ce-name-${props.chargeId}`}>Name on the invoice</label>
                <input
                  id={`ce-name-${props.chargeId}`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor={`ce-gst-${props.chargeId}`}>In GST</label>
                <select
                  id={`ce-gst-${props.chargeId}`}
                  value={gst ? 'Yes' : 'No'}
                  onChange={(event) => setGst(event.target.value === 'Yes')}
                >
                  <option value="Yes">Yes</option>
                  <option value="No">No</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor={`ce-fuel-${props.chargeId}`}>Fuel on it</label>
                <select
                  id={`ce-fuel-${props.chargeId}`}
                  value={fuel ? 'Yes' : 'No'}
                  onChange={(event) => setFuel(event.target.value === 'Yes')}
                >
                  <option value="Yes">Yes</option>
                  <option value="No">No</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor={`ce-oneoff-${props.chargeId}`}>One-off at a booking</label>
                {oneOffPossible ? (
                  <select
                    id={`ce-oneoff-${props.chargeId}`}
                    value={oneOff ? 'Yes' : 'No'}
                    onChange={(event) => setOneOff(event.target.value === 'Yes')}
                  >
                    <option value="Yes">Yes</option>
                    <option value="No">No</option>
                  </select>
                ) : (
                  <span style={{ color: 'var(--ink-faint)', fontSize: 12 }}>
                    not possible for a {props.basisLabel.toLowerCase()} charge
                  </span>
                )}
              </div>
            </div>

            <p className="hint">
              How it is charged — <strong>{props.basisLabel}</strong> — is not editable here.
              Switching it would leave the amount cells meaning something else, so it means
              supplying the new shape&rsquo;s figures on the card itself.
            </p>

            <h4 style={{ marginBottom: 4 }}>Which cards to change</h4>
            <div className="pill-list" style={{ marginTop: 0 }}>
              {cards.map((card) => (
                <label key={card.key} className="chip" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(card.key)}
                    onChange={() => toggle(card.key)}
                    style={{ marginRight: 6 }}
                  />
                  {card.label}
                </label>
              ))}
            </div>

            <div className="callout warn" style={{ marginTop: 10 }}>
              <strong>
                {chosen.length} card{chosen.length === 1 ? '' : 's'} · {chosen.length} separate
                approval{chosen.length === 1 ? '' : 's'}
              </strong>
              <p style={{ margin: '4px 0 0' }}>
                Each card holds its own draft and its own change request, so this lands as a
                draft edit on {chosen.length === 1 ? 'that card' : 'each of them'} and{' '}
                {chosen.length === 1 ? 'needs' : 'each needs'} approving by whoever owns it.
                Nothing is quoted until then.
              </p>
              {contracts.length > 0 && (
                <p style={{ margin: '6px 0 0' }}>
                  {contracts.length} contract{contracts.length === 1 ? '' : 's'} also define this
                  charge — {contracts.map((entry) => entry.label).join(', ')} — and{' '}
                  {contracts.length === 1 ? 'it is' : 'they are'} left alone. A customer who
                  negotiated their own version keeps it.
                </p>
              )}
            </div>

            <div className="inline-form" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="primary"
                disabled={pending || chosen.length === 0}
                onClick={save}
              >
                {pending ? 'Saving…' : `Change on ${chosen.length}`}
              </button>
              <button type="button" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
