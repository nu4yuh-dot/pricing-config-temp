import Link from 'next/link';
import type { SheetSpec } from '../sheets/types';
import type { GridCell } from './SheetGrid';

/**
 * The read-only tabs: the cover, the four engine-computed views, and the pincode
 * master. Each explains what it is and points at the page that does the work,
 * rather than pretending to be an editable grid.
 */
export default function DerivedSheet(props: {
  spec: SheetSpec;
  cells: GridCell[];
  cardKey: string;
  cardName: string;
}) {
  const { spec, cells, cardKey, cardName } = props;
  const titles = cells.filter((cell) => cell.kind === 'title');
  const notes = cells.filter((cell) => cell.kind === 'note');
  const headers = cells.filter((cell) => cell.kind === 'header');

  const destination =
    spec.id === 'pincode-master'
      ? '/pincodes'
      : spec.derived
        ? `/calculator?card=${cardKey}`
        : null;

  return (
    <div className="page">
      <div className="page-inner">
        <h2>{titles[0]?.value ?? spec.name}</h2>
        {notes[0] && <p className="lede">{String(notes[0].value)}</p>}

        {spec.id === 'all-in-quote' && (
          <div className="callout">
            <strong>This tab was wrong in the source workbooks</strong>
            All three files hardcoded Model 1&rsquo;s freight formula here, so opening the Model 2
            or Model 3 workbook and reading this tab showed Model 1 prices. It also rounded fuel
            and GST to whole rupees while the Rate Calculator rounded to one decimal — two sheets
            in one file disagreeing about the same shipment. Here it follows the card you have
            selected, and there is one rounding rule.
          </div>
        )}

        {spec.id === 'nfo-rates' && (
          <div className="callout info">
            <strong>Computed, never stored</strong>
            NFO is the Air card multiplied by the NFO multiplier across all four grids. Because it
            is derived, it cannot drift away from Air Rates — edit Air and NFO follows.
          </div>
        )}

        {destination && (
          <p style={{ marginTop: 18 }}>
            <Link className="btn" href={destination}>
              {spec.id === 'pincode-master'
                ? 'Search the pincode master →'
                : `Open the calculator for ${cardName} →`}
            </Link>
          </p>
        )}

        {headers.length > 0 && (
          <>
            <h3>On this tab</h3>
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ink-soft)' }}>
              {headers.map((header) => (
                <li key={header.ref}>{String(header.value)}</li>
              ))}
            </ul>
          </>
        )}

        {spec.id === 'cover' && (
          <>
            {cells
              .filter((cell) => cell.kind === 'header' || cell.kind === 'note')
              .slice(1)
              .map((cell) => (
                <p key={cell.ref} style={{ color: 'var(--ink-soft)', margin: '4px 0' }}>
                  {String(cell.value)}
                </p>
              ))}
          </>
        )}
      </div>
    </div>
  );
}
