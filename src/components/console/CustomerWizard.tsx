'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  checkCustomerCode,
  createCustomerFromWizard,
  type WizardInput,
} from '../../app/console-actions';
import type { Mode } from '../../domain/types';

/**
 * Four steps to a contract somebody could actually propose.
 *
 * Adding a customer used to be one form and then a blank 21×21 grid, which is a fair
 * description of the problem: the hard part was never the record, it was the first
 * contract. Each step here lands through the ordinary machinery — register, assign a
 * template, set the coverage — so what comes out is indistinguishable from a contract
 * built by hand. This is a better first five minutes, not a second kind of contract.
 */

const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: 'surface', label: 'Surface' },
  { value: 'air', label: 'Air' },
  { value: 'rail', label: 'Rail' },
  { value: 'nfo', label: 'NFO / JIT' },
];

export interface WizardTemplate {
  key: string;
  name: string;
  description: string;
  baseCardKey: string;
  cells: number;
  /** How many contracts were built from it — the mockup's "matches 6 customers". */
  usedBy: number;
  parameters: { bind: string; label: string; example: string | number | null }[];
}

export default function CustomerWizard({
  cards,
  templates,
  customers,
}: {
  cards: { key: string; name: string; method: string }[];
  templates: WizardTemplate[];
  customers: { code: string; name: string; baseCardKey: string; cells: number }[];
}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [gstin, setGstin] = useState('');
  const [pan, setPan] = useState('');
  const [msme, setMsme] = useState('');
  const [addressLine, setAddress] = useState('');
  const [baseCardKey, setBaseCardKey] = useState(cards[0]?.key ?? '');
  const [codeState, setCodeState] = useState<{ available: boolean; reason?: string } | null>(null);

  const [start, setStart] = useState<'template' | 'clone' | 'blank'>('blank');
  const [templateKey, setTemplateKey] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [cloneOf, setCloneOf] = useState('');

  const [modes, setModes] = useState<Mode[]>([]);
  const [bandFrom, setBandFrom] = useState('');
  const [bandTo, setBandTo] = useState('');

  // Only what can mean the same thing on this card. A template written against another
  // card would price the same paths differently, which is not a starting point at all.
  const usable = templates.filter((template) => template.baseCardKey === baseCardKey);
  const clonable = customers.filter(
    (customer) => customer.baseCardKey === baseCardKey && customer.cells > 0,
  );
  const chosenTemplate = usable.find((template) => template.key === templateKey);

  const checkCode = (value: string) => {
    setCode(value);
    setCodeState(null);
    const trimmed = value.trim();
    if (trimmed === '') return;
    startTransition(async () => {
      setCodeState(await checkCustomerCode(trimmed));
    });
  };

  const identityReady = code.trim() !== '' && name.trim() !== '' && codeState?.available === true;

  const save = (propose: boolean) => {
    setError(null);
    const scope = {
      modes: modes.length > 0 ? modes : null,
      lanes: null,
      weightBands:
        bandFrom.trim() === '' && bandTo.trim() === ''
          ? null
          : [{ from: Number(bandFrom || 0), to: bandTo.trim() === '' ? null : Number(bandTo) }],
    };

    const startInput: WizardInput['start'] =
      start === 'template' && templateKey !== ''
        ? {
            kind: 'template',
            templateKey,
            answers: Object.fromEntries(
              Object.entries(answers)
                .filter(([, value]) => value.trim() !== '')
                .map(([bind, value]) => [bind, Number.isFinite(Number(value)) ? Number(value) : value]),
            ),
          }
        : start === 'clone' && cloneOf !== ''
          ? { kind: 'clone', customerCode: cloneOf }
          : { kind: 'blank' };

    startTransition(async () => {
      try {
        const result = await createCustomerFromWizard({
          code,
          name,
          baseCardKey,
          profile: { gstin, pan, msmeNumber: msme, addressLine },
          start: startInput,
          scope,
          propose,
        });
        router.push(
          result.proposalId
            ? `/approvals/contract/${result.proposalId}`
            : `/customers/${encodeURIComponent(result.code)}`,
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not create the customer.');
      }
    });
  };

  const startLabel =
    start === 'template'
      ? `Template — ${chosenTemplate?.name ?? 'none chosen'}`
      : start === 'clone'
        ? `Copied from ${cloneOf || 'nobody chosen'}`
        : `${cards.find((card) => card.key === baseCardKey)?.name ?? baseCardKey}, nothing negotiated`;

  return (
    <div className="panel">
      <header>
        <h3>
          Step {step} of 4 —{' '}
          {['Identity', 'Pricing pattern', 'Coverage', 'Review'][step - 1]}
        </h3>
        <span className="hint">Nothing is saved until the last step</span>
      </header>

      <div className="body">
        {error && <div className="error">{error}</div>}

        {step === 1 && (
          <>
            <div className="inline-form">
              <div className="field" style={{ minWidth: 180 }}>
                <label htmlFor="w-code">Customer code</label>
                <input
                  id="w-code"
                  value={code}
                  placeholder="KIRLOSKAR"
                  onChange={(event) => checkCode(event.target.value)}
                />
              </div>
              <div className="field" style={{ minWidth: 260 }}>
                <label htmlFor="w-name">Legal name</label>
                <input
                  id="w-name"
                  value={name}
                  placeholder="Kirloskar Brothers Ltd"
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="field" style={{ minWidth: 200 }}>
                <label htmlFor="w-card">Priced from</label>
                <select
                  id="w-card"
                  value={baseCardKey}
                  onChange={(event) => {
                    setBaseCardKey(event.target.value);
                    setTemplateKey('');
                    setCloneOf('');
                    setStart('blank');
                  }}
                >
                  {cards.map((card) => (
                    <option key={card.key} value={card.key}>
                      {card.name} · {card.method}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {codeState && (
              <p
                style={{
                  fontSize: 11.5,
                  color: codeState.available ? 'var(--live)' : 'var(--rejected)',
                  margin: '6px 0 0',
                }}
              >
                {codeState.available
                  ? `${code.trim().toUpperCase()} is available.`
                  : codeState.reason}
              </p>
            )}

            <div className="inline-form" style={{ marginTop: 12 }}>
              <div className="field" style={{ minWidth: 190 }}>
                <label htmlFor="w-gstin">GSTIN</label>
                <input id="w-gstin" value={gstin} onChange={(e) => setGstin(e.target.value)} />
              </div>
              <div className="field" style={{ minWidth: 150 }}>
                <label htmlFor="w-pan">PAN</label>
                <input id="w-pan" value={pan} onChange={(e) => setPan(e.target.value)} />
              </div>
              <div className="field" style={{ minWidth: 170 }}>
                <label htmlFor="w-msme">MSME / Udyam</label>
                <input id="w-msme" value={msme} onChange={(e) => setMsme(e.target.value)} />
              </div>
              <div className="field" style={{ minWidth: 260 }}>
                <label htmlFor="w-addr">Registered address</label>
                <input id="w-addr" value={addressLine} onChange={(e) => setAddress(e.target.value)} />
              </div>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>
              Identity is reference data — it is checked, not approved, because none of it can
              change what anybody is charged. The base card can, which is why it is here and not
              editable later.
            </p>
          </>
        )}

        {step === 2 && (
          <>
            <p style={{ marginTop: 0 }}>
              Pick a starting point. Everything here is still editable before you propose.
            </p>

            <div className="pill-list" style={{ marginTop: 0 }}>
              <button
                type="button"
                className={`pill${start === 'template' ? ' on' : ''}`}
                disabled={usable.length === 0}
                onClick={() => setStart('template')}
              >
                From a template{usable.length === 0 ? ' — none for this card' : ''}
              </button>
              <button
                type="button"
                className={`pill${start === 'clone' ? ' on' : ''}`}
                disabled={clonable.length === 0}
                onClick={() => setStart('clone')}
              >
                Copy a customer{clonable.length === 0 ? ' — none on this card' : ''}
              </button>
              <button
                type="button"
                className={`pill${start === 'blank' ? ' on' : ''}`}
                onClick={() => setStart('blank')}
              >
                Standard prices
              </button>
            </div>

            {start === 'template' && (
              <div style={{ marginTop: 12 }}>
                <table className="data">
                  <tbody>
                    {usable.map((template) => (
                      <tr
                        key={template.key}
                        className={template.key === templateKey ? 'selected' : undefined}
                      >
                        <td>
                          <button
                            type="button"
                            className={`pill${template.key === templateKey ? ' on' : ''}`}
                            onClick={() => setTemplateKey(template.key)}
                          >
                            {template.name}
                          </button>
                        </td>
                        <td style={{ color: 'var(--ink-soft)' }}>{template.description}</td>
                        <td className="num">{template.cells} cells</td>
                        <td className="num">
                          {template.usedBy === 0
                            ? 'first use'
                            : `${template.usedBy} contract${template.usedBy === 1 ? '' : 's'}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {chosenTemplate && chosenTemplate.parameters.length > 0 && (
                  <>
                    <p style={{ fontSize: 12, marginBottom: 4 }}>
                      <strong>{chosenTemplate.name}</strong> asks for{' '}
                      {chosenTemplate.parameters.length} value
                      {chosenTemplate.parameters.length === 1 ? '' : 's'}:
                    </p>
                    <div className="inline-form">
                      {chosenTemplate.parameters.map((parameter) => (
                        <div className="field" key={parameter.bind} style={{ minWidth: 150 }}>
                          <label htmlFor={`w-${parameter.bind}`}>{parameter.label}</label>
                          <input
                            id={`w-${parameter.bind}`}
                            inputMode="decimal"
                            value={answers[parameter.bind] ?? ''}
                            placeholder={
                              parameter.example === null ? 'no example' : `e.g. ${parameter.example}`
                            }
                            onChange={(event) =>
                              setAnswers({ ...answers, [parameter.bind]: event.target.value })
                            }
                          />
                        </div>
                      ))}
                    </div>
                    <p style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>
                      Left blank means not written at all — the example beside a field is the
                      template author&rsquo;s, not a value anybody agreed for this customer.
                    </p>
                  </>
                )}
              </div>
            )}

            {start === 'clone' && (
              <div className="inline-form" style={{ marginTop: 12 }}>
                <div className="field" style={{ minWidth: 280 }}>
                  <label htmlFor="w-clone">Copy the contract of</label>
                  <select
                    id="w-clone"
                    value={cloneOf}
                    onChange={(event) => setCloneOf(event.target.value)}
                  >
                    <option value="">Choose a customer…</option>
                    {clonable.map((customer) => (
                      <option key={customer.code} value={customer.code}>
                        {customer.name} · {customer.cells} cells
                      </option>
                    ))}
                  </select>
                </div>
                <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', maxWidth: 380 }}>
                  Their <strong>approved</strong> contract, not their draft. Copying a
                  half-finished negotiation would start this customer from a position nobody has
                  agreed to.
                </p>
              </div>
            )}

            {start === 'blank' && (
              <p style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                Standard prices, nothing negotiated. A perfectly good answer — the contract stays
                sparse and tracks every future change to the card.
              </p>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <p style={{ marginTop: 0 }}>
              Coverage is what will be <em>quoted</em>. A booking outside it is declined rather
              than priced high, which is the point of stating it.
            </p>

            <strong style={{ fontSize: 12 }}>Modes accepted at contract prices</strong>
            <div className="pill-list">
              {MODE_OPTIONS.map((option) => (
                <label key={option.value}>
                  <input
                    type="checkbox"
                    checked={modes.includes(option.value)}
                    onChange={() =>
                      setModes(
                        modes.includes(option.value)
                          ? modes.filter((mode) => mode !== option.value)
                          : [...modes, option.value],
                      )
                    }
                  />{' '}
                  {option.label}
                </label>
              ))}
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>
              None ticked means every mode, which is the safe default — a contract that covers
              nothing quotes nothing.
            </p>

            <strong style={{ fontSize: 12 }}>Weight band</strong>
            <div className="inline-form">
              <div className="field" style={{ maxWidth: 130 }}>
                <label htmlFor="w-from">From (kg)</label>
                <input id="w-from" inputMode="decimal" value={bandFrom} onChange={(e) => setBandFrom(e.target.value)} />
              </div>
              <div className="field" style={{ maxWidth: 190 }}>
                <label htmlFor="w-to">To (kg, blank = no limit)</label>
                <input id="w-to" inputMode="decimal" value={bandTo} onChange={(e) => setBandTo(e.target.value)} />
              </div>
            </div>

            <p style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>
              Restricting coverage to a geography is not offered here on purpose. Contract
              coverage is a list of lanes, and &ldquo;Maharashtra&rdquo; is not one — it becomes
              lanes only once its pincodes are resolved. Price a state with a lane rule on the
              contract instead, where the same picker can show what it would touch.
            </p>
          </>
        )}

        {step === 4 && (
          <table className="data">
            <tbody>
              <tr>
                <td style={{ width: 160 }}>Customer</td>
                <td>
                  {name} <span className="ref">({code.trim().toUpperCase()})</span>
                </td>
              </tr>
              <tr>
                <td>Starting point</td>
                <td>{startLabel}</td>
              </tr>
              <tr>
                <td>Coverage</td>
                <td>
                  {modes.length === 0 ? 'Every mode' : modes.join(', ')}
                  {bandFrom || bandTo
                    ? `, ${bandFrom || 0}–${bandTo || 'no limit'} kg`
                    : ', all weights'}
                </td>
              </tr>
              <tr>
                <td>Identity</td>
                <td style={{ color: 'var(--ink-soft)' }}>
                  {[gstin && `GSTIN ${gstin}`, pan && `PAN ${pan}`, msme && `Udyam ${msme}`]
                    .filter(Boolean)
                    .join(' · ') || 'none recorded'}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      <div className="actionbar">
        {step > 1 && (
          <button type="button" onClick={() => setStep(step - 1)} disabled={pending}>
            ← Back
          </button>
        )}
        <span className="spacer" />
        {step < 4 ? (
          <button
            type="button"
            className="primary"
            disabled={pending || (step === 1 && !identityReady)}
            onClick={() => setStep(step + 1)}
          >
            Continue →
          </button>
        ) : (
          <>
            <button type="button" onClick={() => save(false)} disabled={pending}>
              {pending ? 'Saving…' : 'Save as draft'}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => save(true)}
              disabled={pending}
            >
              {pending ? 'Saving…' : 'Save and propose →'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
