'use client';

import { useActionState, useState } from 'react';
import { assignTemplate, type AssignTemplateResult } from '../../app/console-actions';

/**
 * Start a contract from a saved template instead of building it lane by lane.
 *
 * `fill-gaps` is the default because it cannot lose work: anything the customer has
 * already negotiated is kept. `replace` discards those, so it says so plainly and
 * needs a deliberate choice.
 */
export interface AssignableTemplate {
  key: string;
  name: string;
  description: string;
  cells: number;
  /** Cells this template asks the customer for, already labelled. */
  parameters: { bind: string; label: string; example: string | number | null }[];
  /** Where it would overwrite something this customer negotiated. */
  conflicts: { bind: string; label: string; theirs: string | number | null; template: string | number | null }[];
  /** Share of the overlap that already agrees, or null when there is nothing to compare. */
  agreement: number | null;
  agreeing: number;
}

export default function ApplyTemplatePanel({
  customerCode,
  templates,
  hasOwnTerms,
  canEdit,
}: {
  customerCode: string;
  templates: AssignableTemplate[];
  hasOwnTerms: boolean;
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(
    assignTemplate,
    null as AssignTemplateResult | null,
  );
  const [mode, setMode] = useState<'fill-gaps' | 'replace'>('fill-gaps');
  const [chosen, setChosen] = useState(templates[0]?.key ?? '');
  const template = templates.find((entry) => entry.key === chosen) ?? templates[0];

  if (templates.length === 0) {
    return (
      <div className="panel">
        <header>
          <h3>Start from a template</h3>
          <span className="hint">Nothing saved yet</span>
        </header>
        <div className="empty">
          No templates exist. Once a contract works well, save it on the{' '}
          <a href="/templates">Templates</a> page and it can be assigned to the next similar
          customer.
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <header>
        <h3>Start from a template</h3>
        <span className="hint">Lands in the draft — still needs approval</span>
      </header>
      <form action={action}>
        <input type="hidden" name="customerCode" value={customerCode} />
        <input type="hidden" name="mode" value={mode} />
        <div className="body">
          {state?.error && <div className="error">{state.error}</div>}
          {template && template.conflicts.length > 0 && (
            <div className="callout" style={{ marginTop: 0 }}>
              <strong>
                {template.conflicts.length} field
                {template.conflicts.length === 1 ? '' : 's'} already negotiated differently
              </strong>
              <ul style={{ margin: '6px 0 0' }}>
                {template.conflicts.slice(0, 6).map((conflict) => (
                  <li key={conflict.bind}>
                    {conflict.label} — they have {String(conflict.theirs ?? 'nothing')}, this
                    template sets {String(conflict.template ?? 'nothing')}.
                  </li>
                ))}
                {template.conflicts.length > 6 && <li>…and {template.conflicts.length - 6} more.</li>}
              </ul>
              <p style={{ margin: '6px 0 0' }}>
                {mode === 'fill-gaps'
                  ? 'Filling the gaps keeps every one of these as they stand.'
                  : 'Replacing overwrites every one of these with the template’s value.'}
              </p>
            </div>
          )}

          {template && template.parameters.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <strong style={{ fontSize: 12 }}>
                This template asks for {template.parameters.length} value
                {template.parameters.length === 1 ? '' : 's'}
              </strong>
              <div className="inline-form" style={{ marginTop: 6 }}>
                {template.parameters.map((parameter) => (
                  <div className="field" key={parameter.bind} style={{ minWidth: 160 }}>
                    <label htmlFor={`answer-${parameter.bind}`}>{parameter.label}</label>
                    <input
                      id={`answer-${parameter.bind}`}
                      name={`answer:${parameter.bind}`}
                      inputMode="decimal"
                      placeholder={
                        parameter.example === null ? 'no example' : `e.g. ${parameter.example}`
                      }
                    />
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', margin: '6px 0 0' }}>
                A field left blank is not written at all. The number beside it is the template
                author’s example, never a default — nobody negotiated it for this customer.
              </p>
            </div>
          )}

          {state?.ok && (
            <div className="callout info" style={{ marginTop: 0 }}>
              Applied <strong>{state.applied}</strong> value{state.applied === 1 ? '' : 's'}
              {(state.kept ?? 0) > 0 && (
                <>
                  , kept <strong>{state.kept}</strong> the customer had already negotiated
                </>
              )}
              {(state.unanswered ?? 0) > 0 && (
                <>
                  {' '}
                  <strong>{state.unanswered}</strong> parameter
                  {state.unanswered === 1 ? '' : 's'} left blank, so nothing was written for
                  {state.unanswered === 1 ? ' it' : ' them'}.
                </>
              )}
              . Review and submit them below.
            </div>
          )}

          <div className="inline-form" style={{ marginBottom: 12 }}>
            <div className="field" style={{ minWidth: 280 }}>
              <label htmlFor="at-template">Template</label>
              <select
                id="at-template"
                name="templateKey"
                value={chosen}
                onChange={(event) => setChosen(event.target.value)}
              >
                {templates.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name} ({t.cells} cells)
                    {t.agreement === null ? '' : ` · ${Math.round(t.agreement * 100)}% already agrees`}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="pill-list" style={{ marginTop: 0 }}>
            <button
              type="button"
              className={`pill${mode === 'fill-gaps' ? ' on' : ''}`}
              onClick={() => setMode('fill-gaps')}
            >
              Fill the gaps
            </button>
            <button
              type="button"
              className={`pill${mode === 'replace' ? ' on' : ''}`}
              onClick={() => setMode('replace')}
            >
              Replace everything
            </button>
          </div>

          <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', margin: '8px 0 0' }}>
            {mode === 'fill-gaps' ? (
              <>
                Keeps anything this customer has already negotiated and fills in the rest from the
                template. Cannot lose work.
              </>
            ) : (
              <>
                <strong style={{ color: 'var(--rejected)' }}>
                  Discards everything this customer has negotiated
                </strong>{' '}
                and uses the template alone.
                {hasOwnTerms && ' They already have negotiated terms, which would be lost.'}
              </>
            )}
          </p>
        </div>

        {canEdit && (
          <div className="actionbar">
            <span className="spacer" />
            <button className="primary" type="submit" disabled={pending}>
              {pending ? 'Applying…' : mode === 'replace' ? 'Replace with template' : 'Fill gaps from template'}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
