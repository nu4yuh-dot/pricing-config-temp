'use client';

import { useState, useTransition } from 'react';

/**
 * GST by mode, the fuel base and the charge menu, as dropdowns.
 *
 * Every switch here is a yes/no decision, so it is a `select` rather than a cell you
 * type "Yes" into. The same values are editable as cells on the Tax & Charges tab for
 * anyone who prefers the spreadsheet; both write to the same draft and need the same
 * approval.
 */

export interface FlagField {
  bind: string;
  value: boolean;
  liveValue: boolean;
}

export interface NumberField {
  bind: string;
  /** Percentages are shown and typed as percentages, stored as fractions. */
  unit: 'percent' | 'currency' | 'text';
  value: string;
  liveValue: string;
}

export interface ModeTaxRow {
  mode: string;
  label: string;
  transport: string;
  sac: NumberField;
  gstRate: NumberField;
  rcm: FlagField;
  itc: FlagField;
}

export interface ChargeRow {
  id: string;
  name: NumberField;
  basisLabel: string;
  amount: NumberField;
  amountEditable: boolean;
  gstApplies: FlagField;
  fuelApplies: FlagField;
  active: FlagField;
  modes: string;
}

/** One destination's express surcharge. */
export interface EssZoneRow {
  zone: string;
  field: NumberField;
}

export interface FuelBaseRow {
  label: string;
  note: string;
  field: FlagField;
}

export type Edit = { bind: string; value: string | number | null };

const YES = 'Yes';
const NO = 'No';

/** Turn a charge name into a stable id, the same way template keys are made. */
const chargeId = (name: string): string =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export default function TaxChargesEditor(props: {
  modes: ModeTaxRow[];
  fuelBase: FuelBaseRow[];
  charges: ChargeRow[];
  /** Per-destination express surcharges. Omitted where they are not negotiated. */
  essZones?: EssZoneRow[];
  /** What these edits affect. Differs between a base card and one customer's contract. */
  scopeNote?: string;
  canEdit: boolean;
  onSave: (edits: Edit[]) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // A charge the standard menu does not have — a demurrage, a site levy, a deposit. It is
  // saved on its own rather than through the draft map, because the map is keyed by the
  // fields already on screen and a charge that does not exist yet has none.
  const [newName, setNewName] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newInGst, setNewInGst] = useState(YES);
  const [addPending, startAdd] = useTransition();

  const newId = chargeId(newName);
  const duplicate = newId !== '' && props.charges.some((row) => row.id === newId);
  const amountValue = Number(newAmount.replace(/[₹,\s]/g, ''));
  const canAdd =
    newId !== '' && !duplicate && newAmount.trim() !== '' && Number.isFinite(amountValue);

  const addCharge = () => {
    setError(null);
    startAdd(async () => {
      try {
        await props.onSave([
          { bind: `chargeCatalog.${newId}.name`, value: newName.trim() },
          { bind: `chargeCatalog.${newId}.amount`, value: amountValue },
          { bind: `chargeCatalog.${newId}.gstApplies`, value: newInGst },
          { bind: `chargeCatalog.${newId}.fuelApplies`, value: NO },
          { bind: `chargeCatalog.${newId}.active`, value: YES },
        ]);
        setNewName('');
        setNewAmount('');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not add that charge.');
      }
    });
  };

  const flagShown = (field: FlagField): string =>
    field.bind in drafts ? (drafts[field.bind] as string) : field.value ? YES : NO;

  const textShown = (field: NumberField): string =>
    field.bind in drafts ? (drafts[field.bind] as string) : field.value;

  const set = (bind: string, value: string) => {
    setSaved(false);
    setDrafts((current) => ({ ...current, [bind]: value }));
  };

  /** One entry per field whose shown value differs from what is stored. */
  const changes: Edit[] = [];
  for (const bind of Object.keys(drafts)) {
    const raw = drafts[bind] as string;
    const flag = [...props.modes.flatMap((row) => [row.rcm, row.itc]), ...props.fuelBase.map((row) => row.field), ...props.charges.flatMap((row) => [row.gstApplies, row.fuelApplies, row.active])].find(
      (field) => field.bind === bind,
    );
    if (flag) {
      const next = raw === YES;
      if (next !== flag.value) changes.push({ bind, value: raw });
      continue;
    }
    const text = [
      ...props.modes.flatMap((row) => [row.sac, row.gstRate]),
      ...props.charges.flatMap((row) => [row.name, row.amount]),
      ...(props.essZones ?? []).map((row) => row.field),
    ].find((field) => field.bind === bind);
    if (!text) continue;
    if (raw.trim() === text.value.trim()) continue;
    if (text.unit === 'text') {
      changes.push({ bind, value: raw.trim() === '' ? null : raw.trim() });
      continue;
    }
    const numeric = Number(raw.replace(/[%,₹\s]/g, ''));
    if (!Number.isFinite(numeric)) continue;
    changes.push({ bind, value: text.unit === 'percent' ? numeric / 100 : numeric });
  }

  const save = () => {
    setError(null);
    startTransition(async () => {
      try {
        await props.onSave(changes);
        setDrafts({});
        setSaved(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not save those changes.');
      }
    });
  };

  const flagSelect = (field: FlagField) => {
    const shown = flagShown(field);
    const dirty = (shown === YES) !== field.value;
    const drafted = field.value !== field.liveValue;
    return (
      <select
        className={dirty ? 'changed' : drafted ? 'overridden' : undefined}
        value={shown}
        disabled={!props.canEdit}
        onChange={(event) => set(field.bind, event.target.value)}
      >
        <option value={YES}>Yes</option>
        <option value={NO}>No</option>
      </select>
    );
  };

  const textInput = (field: NumberField, size: number) => {
    const shown = textShown(field);
    const dirty = shown.trim() !== field.value.trim();
    const drafted = field.value !== field.liveValue;
    return (
      <input
        className={dirty ? 'changed' : drafted ? 'overridden' : undefined}
        size={size}
        inputMode={field.unit === 'text' ? 'text' : 'decimal'}
        value={shown}
        disabled={!props.canEdit}
        onChange={(event) => set(field.bind, event.target.value)}
      />
    );
  };

  return (
    <>
      <div className="panel">
        <header>
          <h3>GST by mode</h3>
          <span className="hint">
            GST follows the transport, not the customer. A road leg is taxed as GTA whatever the
            customer would prefer.
          </span>
        </header>
        <div className="body">
          <table className="data">
            <thead>
              <tr>
                <th>Mode</th>
                <th>Transport</th>
                <th>SAC</th>
                <th className="num">GST %</th>
                <th>Reverse charge</th>
                <th>ITC</th>
              </tr>
            </thead>
            <tbody>
              {props.modes.map((row) => (
                <tr key={row.mode}>
                  <td>
                    <strong>{row.label}</strong>
                  </td>
                  <td style={{ color: 'var(--ink-soft)' }}>{row.transport}</td>
                  <td>{textInput(row.sac, 6)}</td>
                  <td className="num">{textInput(row.gstRate, 5)}</td>
                  <td>{flagSelect(row.rcm)}</td>
                  <td>{flagSelect(row.itc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint" style={{ marginTop: 8 }}>
            Reverse charge means the consignee accounts for the GST: the quote shows zero and states
            the rate, because the invoice still has to.
          </p>
        </div>
      </div>

      <div className="panel">
        <header>
          <h3>What the fuel surcharge is charged on</h3>
          <span className="hint">
            The percentage itself is on Charges &amp; surcharges. This is the base it applies to.
          </span>
        </header>
        <div className="body">
          <table className="data">
            <tbody>
              {props.fuelBase.map((row) => (
                <tr key={row.field.bind}>
                  <td style={{ width: 160 }}>
                    <strong>{row.label}</strong>
                  </td>
                  <td style={{ width: 90 }}>{flagSelect(row.field)}</td>
                  <td style={{ color: 'var(--ink-soft)' }}>{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <header>
          <h3>Charge menu</h3>
          <span className="hint">
            Switch a charge off and it leaves every quote, but stays here to be switched back on.
          </span>
        </header>
        <div className="body">
          <table className="data">
            <thead>
              <tr>
                <th>Charge</th>
                <th>How it is charged</th>
                <th className="num">Amount</th>
                <th>In GST</th>
                <th>Fuel on it</th>
                <th>Active</th>
                <th>Modes</th>
              </tr>
            </thead>
            <tbody>
              {props.charges.map((row) => (
                <tr key={row.id}>
                  <td>{textInput(row.name, 16)}</td>
                  <td style={{ color: 'var(--ink-soft)' }}>{row.basisLabel}</td>
                  <td className="num">
                    {row.amountEditable ? (
                      textInput(row.amount, 6)
                    ) : (
                      <span style={{ color: 'var(--ink-faint)' }}>from the lane</span>
                    )}
                  </td>
                  <td>{flagSelect(row.gstApplies)}</td>
                  <td>{flagSelect(row.fuelApplies)}</td>
                  <td>{flagSelect(row.active)}</td>
                  <td style={{ color: 'var(--ink-soft)' }}>{row.modes || 'every mode'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint" style={{ marginTop: 8 }}>
            A charge outside GST is added after tax, which is right for a deposit or a
            reimbursement. “Fuel on it” levies fuel on that charge alone — use the fuel base above
            for fuel on total; the engine never charges both.
          </p>
        </div>
      </div>

      {props.canEdit && (
        <div className="panel">
          <header>
            <h3>Add a charge</h3>
            <span className="hint">
              For anything the menu above does not have — a demurrage, a site levy, a deposit.
            </span>
          </header>
          <div className="body">
            <div className="inline-form">
              <div className="field" style={{ minWidth: 200 }}>
                <label htmlFor="new-charge-name">Name on the invoice</label>
                <input
                  id="new-charge-name"
                  value={newName}
                  placeholder="Site entry levy"
                  onChange={(event) => setNewName(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="new-charge-amount">Amount ₹</label>
                <input
                  id="new-charge-amount"
                  inputMode="decimal"
                  size={8}
                  value={newAmount}
                  onChange={(event) => setNewAmount(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="new-charge-gst">In GST</label>
                <select
                  id="new-charge-gst"
                  value={newInGst}
                  onChange={(event) => setNewInGst(event.target.value)}
                >
                  <option value={YES}>Yes</option>
                  <option value={NO}>No</option>
                </select>
              </div>
              <button className="primary" type="button" onClick={addCharge} disabled={!canAdd || addPending}>
                {addPending ? 'Adding…' : 'Add charge'}
              </button>
            </div>
            {duplicate && (
              <p className="error" style={{ marginTop: 8 }}>
                There is already a charge called that. Edit it in the menu above instead.
              </p>
            )}
            <p className="hint" style={{ marginTop: 8 }}>
              It is charged flat, per shipment, and starts active. “In GST = No” adds it after
              tax, which is right for a deposit or a reimbursement. Once added it appears in the
              menu above, where its amount and treatment can be changed like any other.
            </p>
          </div>
        </div>
      )}

      {props.essZones && (
        <div className="panel">
          <header>
            <h3>Express surcharge by destination</h3>
            <span className="hint">
              Charged on top when the shipment is going to that zone. Blank means none.
            </span>
          </header>
          <div className="body">
            <div className="rate-fields" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
              {props.essZones.map((row) => {
                const shown = textShown(row.field);
                const dirty = shown.trim() !== row.field.value.trim();
                return (
                  <div key={row.zone} className={`rate-field${dirty ? ' changed' : ''}`}>
                    <label htmlFor={`ess-${row.zone}`}>
                      {row.zone} <span className="unit">₹</span>
                    </label>
                    <input
                      id={`ess-${row.zone}`}
                      inputMode="decimal"
                      value={shown}
                      disabled={!props.canEdit}
                      placeholder="none"
                      onChange={(event) => set(row.field.bind, event.target.value)}
                    />
                  </div>
                );
              })}
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              These only reach a quote when <strong>ESS</strong> is Active in the charge menu
              above.
            </p>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {props.canEdit && (
        <div className="actionbar">
          {changes.length > 0 ? (
            <span className="chip draft count">
              {changes.length} change{changes.length === 1 ? '' : 's'}
            </span>
          ) : saved ? (
            <span className="chip live">Saved to draft</span>
          ) : (
            <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>No changes</span>
          )}
          <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
            {props.scopeNote ?? 'These change the tax and the charge lines on every quote from this card.'}
          </span>
          <span className="spacer" />
          {changes.length > 0 && (
            <button onClick={() => setDrafts({})} disabled={pending}>
              Revert
            </button>
          )}
          <button className="primary" onClick={save} disabled={changes.length === 0 || pending}>
            {pending ? 'Saving…' : 'Save to draft'}
          </button>
        </div>
      )}
    </>
  );
}
