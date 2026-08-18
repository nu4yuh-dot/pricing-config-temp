import { AIR_ZONES, SURFACE_ZONES } from '../../domain/zones';
import type { SheetSpec } from '../types';

/** The three transit-time matrices, at the same coordinates as the source. */

interface TransitShape {
  id: string;
  name: string;
  columns: number;
  /** Which `transitTimes` branch this sheet edits. */
  mode: 'air' | 'surface' | 'rail';
  title: string;
  gridTitle: string;
  zones: readonly string[];
  panelAt: string;
  panelTitle: string;
  panelLines: string[];
}

function transitSheet(shape: TransitShape): SheetSpec {
  return {
    id: shape.id,
    name: shape.name,
    columns: shape.columns,
    blocks: [
      { type: 'title', at: 'A1', text: shape.title },
      {
        type: 'matrix',
        at: 'A3',
        title: shape.gridTitle,
        shortName: 'transit',
        rowKeys: shape.zones,
        colKeys: shape.zones,
        bind: `transitTimes.${shape.mode}`,
        corner: 'From\\To',
        format: 'days',
      },
      { type: 'notePanel', at: shape.panelAt, title: shape.panelTitle, lines: shape.panelLines },
    ],
  };
}

export const tatAirSpec = transitSheet({
  id: 'tat-air',
  name: 'TAT Air',
  columns: 20,
  mode: 'air',
  title: 'AIR — TRANSIT TIME (working days)',
  gridTitle: 'AIR TAT (days)',
  zones: AIR_ZONES,
  panelAt: 'O3',
  panelTitle: 'HOW TO READ — AIR TAT',
  panelLines: [
    'Transit time in working days. Find the origin row and the destination column.',
    'Indicative; excludes force majeure and customs or regulatory holds.',
    'NFO / JIT is 10–14 hours rather than a day count.',
  ],
});

export const tatSurfaceSpec = transitSheet({
  id: 'tat-surface',
  name: 'TAT Surface',
  columns: 29,
  mode: 'surface',
  title: 'SURFACE — TRANSIT TIME (working days)',
  gridTitle: 'SURFACE TAT (days)',
  zones: SURFACE_ZONES,
  panelAt: 'X3',
  panelTitle: 'HOW TO READ — SURFACE TAT',
  panelLines: [
    'Transit time in working days by road. Origin row by destination column.',
    'Indicative; excludes force majeure.',
  ],
});

export const etaRailSpec = transitSheet({
  id: 'eta-rail',
  name: 'ETA Rail',
  columns: 29,
  mode: 'rail',
  title: 'RAIL — TRANSIT ETA (days)',
  gridTitle: 'RAIL ETA (days)',
  zones: SURFACE_ZONES,
  panelAt: 'X3',
  panelTitle: 'HOW TO READ — RAIL ETA',
  panelLines: [
    'Rail transit in working days (fastest-train basis plus handling).',
    'Rail is faster than surface on long lanes.',
    '“-” means rail is not viable on that lane — use Surface.',
  ],
});
