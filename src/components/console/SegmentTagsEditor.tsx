'use client';

import { useState, useTransition } from 'react';
import { saveCustomerTags } from '../../app/console-actions';

/**
 * The segments a customer belongs to.
 *
 * Free text with the existing tags offered as suggestions, rather than a fixed list. A
 * segment is a commercial idea that changes faster than a deployment; suggesting what is
 * already in use is what stops "Ecom", "E-com" and "ecommerce" becoming three segments
 * that each look half empty.
 */
export default function SegmentTagsEditor({
  customerCode,
  tags,
  known,
  canEdit,
}: {
  customerCode: string;
  tags: string[];
  known: string[];
  canEdit: boolean;
}) {
  const [current, setCurrent] = useState(tags);
  const [entry, setEntry] = useState('');
  const [pending, startTransition] = useTransition();

  const save = (next: string[]) => {
    setCurrent(next);
    startTransition(async () => {
      await saveCustomerTags(customerCode, next);
    });
  };

  const add = () => {
    const tag = entry.trim();
    if (tag === '') return;
    setEntry('');
    if (current.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return;
    save([...current, tag]);
  };

  const suggestions = known.filter(
    (tag) => !current.some((existing) => existing.toLowerCase() === tag.toLowerCase()),
  );

  return (
    <div className="panel">
      <header>
        <h3>Segments</h3>
        <span className="hint">Decides what is offered, never what is charged</span>
      </header>
      <div className="body">
        <div className="pill-list" style={{ marginTop: 0 }}>
          {current.length === 0 && (
            <span style={{ color: 'var(--ink-faint)', fontSize: 12 }}>
              No segment. No product is offered to this customer.
            </span>
          )}
          {current.map((tag) => (
            <span key={tag} className="chip live">
              {tag}
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Remove ${tag}`}
                  style={{
                    marginLeft: 6,
                    border: 0,
                    background: 'none',
                    cursor: 'pointer',
                    color: 'inherit',
                  }}
                  onClick={() => save(current.filter((entry) => entry !== tag))}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>

        {canEdit && (
          <div className="inline-form" style={{ marginTop: 12 }}>
            <div className="field" style={{ minWidth: 200 }}>
              <label htmlFor="segment-tag">Add a segment</label>
              <input
                id="segment-tag"
                value={entry}
                list="known-segments"
                placeholder="Ecom"
                onChange={(event) => setEntry(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  add();
                }}
              />
              <datalist id="known-segments">
                {suggestions.map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
            </div>
            <button type="button" className="btn" disabled={pending} onClick={add}>
              {pending ? 'Saving…' : 'Add'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
