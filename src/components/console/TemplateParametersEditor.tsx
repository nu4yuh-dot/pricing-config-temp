'use client';

import { useState, useTransition } from 'react';
import { markTemplateParameters } from '../../app/console-actions';

/**
 * Which of a template's fields are decided, and which are asked.
 *
 * The mockup's distinction, and a real one: "docket ₹100" is the same for everybody on
 * this shape, while "West ₹/kg" is the number the negotiation is actually about. Marking
 * the second as a parameter turns a template from a thing you copy and then edit into a
 * thing that asks the question.
 *
 * Marking changes nothing about assignments already made. A template records how the next
 * contract should be built, not a live link to the ones that were.
 */
export default function TemplateParametersEditor({
  templateKey,
  fields,
  parameters,
  canEdit,
}: {
  templateKey: string;
  fields: { bind: string; label: string; value: string | number | null }[];
  parameters: string[];
  canEdit: boolean;
}) {
  const [current, setCurrent] = useState(parameters);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const toggle = (bind: string) => {
    const next = current.includes(bind)
      ? current.filter((entry) => entry !== bind)
      : [...current, bind];
    setCurrent(next);
    setSaved(false);
    startTransition(async () => {
      await markTemplateParameters(templateKey, next);
      setSaved(true);
    });
  };

  return (
    <div className="panel">
      <header>
        <h3>Fields</h3>
        <span className="hint">
          {current.length} asked · {fields.length - current.length} fixed
        </span>
      </header>
      <div className="body">
        <p style={{ marginTop: 0 }}>
          Mark each field as a <strong>parameter</strong> — the next customer is asked for a value
          — or leave it <strong>fixed</strong>, copied as it stands. A parameter left blank at
          assignment is not written at all, so the figure below is an example, never a default.
        </p>

        {fields.length === 0 ? (
          <div className="empty">This template negotiates nothing, so there is nothing to mark.</div>
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Field</th>
                  <th style={{ textAlign: 'right' }}>Value</th>
                  <th>Treated as</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((field) => {
                  const isParameter = current.includes(field.bind);
                  return (
                    <tr key={field.bind}>
                      <td>{field.label}</td>
                      <td className="num">{field.value === null ? 'not carried' : field.value}</td>
                      <td>
                        {canEdit ? (
                          <button
                            type="button"
                            className={`pill${isParameter ? ' on' : ''}`}
                            disabled={pending}
                            onClick={() => toggle(field.bind)}
                          >
                            {isParameter ? 'Parameter' : `Fixed`}
                          </button>
                        ) : (
                          <span className="chip">{isParameter ? 'parameter' : 'fixed'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {saved && (
          <p style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>
            Saved. Contracts already assigned from this template are unaffected.
          </p>
        )}
      </div>
    </div>
  );
}
