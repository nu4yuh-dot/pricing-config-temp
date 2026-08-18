'use client';

import { useState, useTransition } from 'react';

/**
 * Define a charge for the library.
 *
 * Deliberately more than the quick "add a charge" on the Tax & charges tab, which only
 * makes a flat per-shipment amount. A definition names how the charge is computed, whether
 * tax and fuel ride on it, and whether an operator may attach it to a single booking — the
 * facts that decide what it costs, all of which are awkward to discover later once three
 * contracts already carry it.
 */

const BASES: { value: string; label: string; note: string }[] = [
  { value: 'per-shipment', label: 'Flat, per shipment', note: 'One amount, however big the consignment.' },
  { value: 'per-awb', label: 'Flat, per AWB', note: 'One amount per airway bill.' },
  { value: 'per-kg', label: 'Per kg', note: 'Multiplied by the chargeable weight.' },
  {
    value: 'per-destination',
    label: 'By destination zone',
    note: 'An amount per zone — an express surcharge. Cannot be booked one-off.',
  },
  {
    value: 'by-pincode',
    label: 'From the pincode distance',
    note: 'Read off the ODA table. Cannot be booked one-off.',
  },
];

const NOT_ONE_OFF = ['per-destination', 'by-pincode'];

/** `Site entry levy` -> `site-entry-levy`, so the id reads as the thing it names. */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export default function NewChargeForm({
  cards,
  existingIds,
  canEdit,
  onCreate,
}: {
  cards: { key: string; name: string }[];
  existingIds: string[];
  canEdit: boolean;
  onCreate: (
    cardKey: string,
    definition: {
      id: string;
      name: string;
      basis: string;
      gstApplies: boolean;
      fuelApplies: boolean;
      bookableOneOff: boolean;
    },
  ) => Promise<void>;
}) {
  const [cardKey, setCardKey] = useState(cards[0]?.key ?? '');
  const [name, setName] = useState('');
  const [basis, setBasis] = useState('per-shipment');
  const [gstApplies, setGstApplies] = useState(true);
  const [fuelApplies, setFuelApplies] = useState(false);
  const [bookableOneOff, setBookableOneOff] = useState(true);
  const [pending, startTransition] = useTransition();

  const id = slugify(name);
  const duplicate = id !== '' && existingIds.includes(id);
  const oneOffAllowed = !NOT_ONE_OFF.includes(basis);
  const ready = canEdit && id !== '' && !duplicate && cardKey !== '';

  const create = () => {
    startTransition(async () => {
      await onCreate(cardKey, {
        id,
        name: name.trim(),
        basis,
        gstApplies,
        fuelApplies,
        // A basis with no single amount can never be a one-off, whatever the box says.
        bookableOneOff: bookableOneOff && oneOffAllowed,
      });
      setName('');
    });
  };

  return (
    <div className="panel">
      <div className="inline-form">
        <div className="field" style={{ minWidth: 220 }}>
          <label htmlFor="charge-name">Name on the invoice</label>
          <input
            id="charge-name"
            value={name}
            placeholder="Cold storage handling"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="field" style={{ minWidth: 200 }}>
          <label htmlFor="charge-basis">How it is charged</label>
          <select id="charge-basis" value={basis} onChange={(event) => setBasis(event.target.value)}>
            {BASES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ minWidth: 180 }}>
          <label htmlFor="charge-card">Defined on</label>
          <select id="charge-card" value={cardKey} onChange={(event) => setCardKey(event.target.value)}>
            {cards.map((card) => (
              <option key={card.key} value={card.key}>
                {card.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="pill-list" style={{ margin: '0.6rem 0' }}>
        <label>
          <input
            type="checkbox"
            checked={gstApplies}
            onChange={(event) => setGstApplies(event.target.checked)}
          />{' '}
          In GST
        </label>
        <label>
          <input
            type="checkbox"
            checked={fuelApplies}
            onChange={(event) => setFuelApplies(event.target.checked)}
          />{' '}
          Fuel applies to it
        </label>
        <label title={oneOffAllowed ? undefined : 'This basis has no single amount to ask for.'}>
          <input
            type="checkbox"
            checked={bookableOneOff && oneOffAllowed}
            disabled={!oneOffAllowed}
            onChange={(event) => setBookableOneOff(event.target.checked)}
          />{' '}
          Bookable as a one-off
        </label>
      </div>

      <p className="hint">{BASES.find((option) => option.value === basis)?.note}</p>

      {duplicate && (
        <p className="error">
          There is already a charge with the id <code>{id}</code>. Reuse it rather than
          defining a second one that bills almost the same.
        </p>
      )}

      <div className="actionbar">
        <button type="button" className="btn primary" disabled={!ready || pending} onClick={create}>
          {pending ? 'Saving…' : 'Save to library'}
        </button>
        <span className="meta">
          Saved inactive at ₹0, so naming a charge never starts billing anyone. Set its
          amount and switch it on from Tax &amp; charges, where it goes through approval
          like every other value.
        </span>
      </div>
    </div>
  );
}
