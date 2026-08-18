'use client';

import { useActionState, useState } from 'react';
import { importCustomerCsv, type CsvImportResult } from '../../app/console-actions';

/**
 * Configure a whole customer from one file.
 *
 * Always parses and reports before writing anything: the first submit is a preview
 * that touches nothing, so nobody imports a file without seeing how it was
 * interpreted — including how many lanes each group row expanded to.
 */
export default function CsvImportPanel({
  customerCode,
  templateCsv,
  canEdit,
}: {
  customerCode: string;
  templateCsv: string;
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(
    importCustomerCsv,
    null as CsvImportResult | null,
  );
  const [text, setText] = useState('');

  const download = () => {
    const blob = new Blob([templateCsv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'customer-rate-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const readFile = async (file: File) => setText(await file.text());
  const clean = (state?.issues?.length ?? 0) === 0;

  return (
    <div className="panel">
      <header>
        <h3>Configure from a CSV</h3>
        <span className="hint">One file: rates, surcharges, coverage and terms</span>
      </header>
      <form action={action}>
        <input type="hidden" name="customerCode" value={customerCode} />
        <input type="hidden" name="csv" value={text} />
        {state?.preview && clean && <input type="hidden" name="confirm" value="on" />}

        <div className="body">
          <p style={{ marginTop: 0, color: 'var(--ink-soft)', fontSize: 12 }}>
            One instruction per row, so a proposal is standardised from the start. Origin and
            destination accept a group name, so <code>metros,metros</code> is one row rather than
            fifty-six.
          </p>

          <div className="inline-form">
            <button type="button" onClick={download}>
              Download the format
            </button>
            <div className="field">
              <label htmlFor="csv-file">Or choose a file</label>
              <input
                id="csv-file"
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void readFile(file);
                }}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="csv-text">CSV</label>
            <textarea
              id="csv-text"
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="rate,surface,PNQ,NCR,minCharge,450"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
            />
          </div>

          {state?.error && <div className="error">{state.error}</div>}

          {state?.ok && (
            <div className="callout info">
              <strong>Imported</strong>
              {state.cells} value{state.cells === 1 ? '' : 's'} written to the draft. Review and
              submit them below.
            </div>
          )}

          {state?.preview && (
            <>
              {(state.issues?.length ?? 0) > 0 ? (
                <div className="callout bad">
                  <strong>
                    {state.issues?.length} problem{state.issues?.length === 1 ? '' : 's'} — nothing
                    was written
                  </strong>
                  <ul>
                    {state.issues?.slice(0, 12).map((issue, i) => (
                      <li key={i}>
                        <strong>Line {issue.line}:</strong> {issue.message}
                        <div className="ref" style={{ fontSize: 11 }}>
                          {issue.raw}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="callout">
                  <strong>
                    Ready: {state.cells} value{state.cells === 1 ? '' : 's'} across{' '}
                    {state.expansions?.length ?? 0} instruction
                    {(state.expansions?.length ?? 0) === 1 ? '' : 's'}
                  </strong>
                  <ul>
                    {state.expansions?.slice(0, 10).map((e, i) => (
                      <li key={i}>
                        {e.description} — <strong>{e.lanes}</strong> lane{e.lanes === 1 ? '' : 's'}
                      </li>
                    ))}
                  </ul>
                  Press <strong>Import</strong> again to write it to the draft.
                </div>
              )}
            </>
          )}
        </div>

        {canEdit && (
          <div className="actionbar">
            <span style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
              {state?.preview && clean
                ? 'Checked — pressing Import now writes it.'
                : 'The first press only checks the file.'}
            </span>
            <span className="spacer" />
            <button className="primary" type="submit" disabled={text.trim() === '' || pending}>
              {pending ? 'Working…' : state?.preview && clean ? 'Import' : 'Check the file'}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
