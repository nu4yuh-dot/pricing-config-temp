'use client';

import { useState, useTransition } from 'react';
import type { Mode } from '../../domain/types';

/**
 * Name a product: a template, the charges that always ride along, and who it is sold to.
 *
 * The form asks for nothing that could be a price. Rates come from the template and charge
 * amounts from wherever the charge is defined, so there is no field here that could quietly
 * make this product cost a different amount than the same terms typed by hand.
 */

const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: 'surface', label: 'Surface' },
  { value: 'air', label: 'Air' },
  { value: 'rail', label: 'Rail' },
  { value: 'nfo', label: 'NFO' },
];

export default function NewProductForm({
  templates,
  charges,
  segments,
  existingKeys,
  onCreate,
}: {
  templates: { key: string; name: string; cells: number }[];
  charges: { id: string; name: string }[];
  /** Segment tags already in use, so the third product does not invent a fourth spelling. */
  segments: string[];
  existingKeys: string[];
  onCreate: (input: {
    name: string;
    description: string;
    templateKey: string;
    charges: string[];
    modes: Mode[];
    segment: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [templateKey, setTemplateKey] = useState(templates[0]?.key ?? '');
  const [attached, setAttached] = useState<string[]>([]);
  const [modes, setModes] = useState<Mode[]>([]);
  const [segment, setSegment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const key = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const duplicate = key !== '' && existingKeys.includes(key);
  const ready = key !== '' && !duplicate && templateKey !== '' && segment.trim() !== '';

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

  const create = () => {
    setError(null);
    startTransition(async () => {
      try {
        await onCreate({
          name,
          description,
          templateKey,
          charges: attached,
          modes,
          segment,
        });
        setName('');
        setDescription('');
        setAttached([]);
        setModes([]);
        setSegment('');
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : 'Could not save the product.');
      }
    });
  };

  return (
    <div className="panel">
      <div className="inline-form">
        <div className="field" style={{ minWidth: 220 }}>
          <label htmlFor="product-name">What it is called</label>
          <input
            id="product-name"
            value={name}
            placeholder="E-commerce / D2C parcel"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="field" style={{ minWidth: 220 }}>
          <label htmlFor="product-template">Priced from</label>
          <select
            id="product-template"
            value={templateKey}
            onChange={(event) => setTemplateKey(event.target.value)}
          >
            {templates.map((template) => (
              <option key={template.key} value={template.key}>
                {template.name} · {template.cells} cells
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ minWidth: 180 }}>
          <label htmlFor="product-segment">Sold to the segment</label>
          <input
            id="product-segment"
            value={segment}
            list="product-segments"
            placeholder="Ecom"
            onChange={(event) => setSegment(event.target.value)}
          />
          <datalist id="product-segments">
            {segments.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
        </div>
      </div>

      <div className="field" style={{ marginTop: '0.6rem' }}>
        <label htmlFor="product-description">How a salesperson would describe it</label>
        <input
          id="product-description"
          value={description}
          placeholder="Volume parcel with COD, priced flat pan-India."
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <h4 style={{ margin: '1rem 0 0.3rem' }}>Charges that always ride along</h4>
      <div className="pill-list">
        {charges.map((charge) => (
          <label key={charge.id}>
            <input
              type="checkbox"
              checked={attached.includes(charge.id)}
              onChange={() => setAttached(toggle(attached, charge.id))}
            />{' '}
            {charge.name}
          </label>
        ))}
      </div>
      <p style={{ color: 'var(--ink-soft)', fontSize: 12 }}>
        Attaching a charge switches it on and nothing else. Its amount stays wherever it is
        defined, so a product cannot reprice a charge for one segment.
      </p>

      <h4 style={{ margin: '1rem 0 0.3rem' }}>Sold for</h4>
      <div className="pill-list">
        {MODE_OPTIONS.map((option) => (
          <label key={option.value}>
            <input
              type="checkbox"
              checked={modes.includes(option.value)}
              onChange={() => setModes(toggle(modes, option.value))}
            />{' '}
            {option.label}
          </label>
        ))}
      </div>
      <p style={{ color: 'var(--ink-soft)', fontSize: 12 }}>
        Leave every mode unticked to sell it wherever the template already reaches.
      </p>

      {duplicate && (
        <p className="error">
          There is already a product at <code>{key}</code>. Edit that one rather than selling
          two things under names nobody can tell apart.
        </p>
      )}
      {error && <p className="error">{error}</p>}

      <div className="actionbar">
        <button type="button" className="btn primary" disabled={!ready || pending} onClick={create}>
          {pending ? 'Saving…' : 'Add to catalog'}
        </button>
        <span style={{ color: 'var(--ink-soft)', fontSize: 12 }}>
          A segment is required: a product with none is offered to nobody, and that is a
          half-finished product rather than a universal one.
        </span>
      </div>
    </div>
  );
}
