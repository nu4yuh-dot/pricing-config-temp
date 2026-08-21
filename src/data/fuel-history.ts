import { listCards, versionHistory } from './rate-cards';
import { STORED_MODES, type StoredMode } from '../domain/types';

/**
 * How fuel has moved, derived from the card versions that already exist.
 *
 * Fuel is a surcharge percentage on a rate card, and every approved change to a card
 * writes a new version and archives the old one. So the history of the fuel index is
 * already in the database — it has simply never been read that way.
 *
 * Deriving it rather than keeping a separate log matters for a reason beyond tidiness: a
 * log written alongside the change can disagree with the change. A reading taken from the
 * versions themselves is the fuel that was actually charged, because it is the same number
 * the engine priced from.
 */

export interface FuelReading {
  cardKey: string;
  cardName: string;
  version: number;
  /** When this version became the one quotes priced from. */
  at: Date;
  approvedBy: string;
  /** As a percentage, which is how a person discusses fuel. Stored as a fraction. */
  surface: number;
  air: number;
  rail: number;
}

export interface FuelMovement {
  mode: StoredMode;
  from: number;
  to: number;
  /** Percentage points, signed. The number a commercial conversation is actually about. */
  change: number;
  at: Date;
  version: number;
}

const pct = (fraction: number | undefined) => Math.round((fraction ?? 0) * 10000) / 100;

/** Every card's fuel, version by version, newest first. */
export async function fuelHistory(limit = 30): Promise<FuelReading[]> {
  const cards = await listCards();
  const readings: FuelReading[] = [];

  for (const card of cards) {
    const versions = await versionHistory(card.key, limit);
    for (const version of versions) {
      // A draft has never priced anything, so it is not part of the history of what was
      // charged — only of what somebody was considering.
      if (version.state === 'draft' || version.state === 'pending') continue;

      const charges = version.data.charges;
      readings.push({
        cardKey: card.key,
        cardName: card.name,
        version: version.version,
        at: version.approvedAt ?? version.createdAt,
        approvedBy: version.approvedBy?.name ?? version.createdBy.name,
        surface: pct(charges.fuelSurface),
        air: pct(charges.fuelAir),
        rail: pct(charges.fuelRail),
      });
    }
  }

  return readings.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/**
 * Only the versions where fuel actually moved.
 *
 * Most approvals change a rate, not the fuel index. Listing every version would bury the
 * three that matter in fifty that do not, and the question this screen answers is "when
 * did fuel last change, and by how much".
 */
export function fuelMovements(readings: readonly FuelReading[]): FuelMovement[] {
  const movements: FuelMovement[] = [];
  const byCard = new Map<string, FuelReading[]>();

  for (const reading of readings) {
    byCard.set(reading.cardKey, [...(byCard.get(reading.cardKey) ?? []), reading]);
  }

  for (const versions of byCard.values()) {
    // Oldest first, so each reading is compared with the one it replaced.
    const ordered = [...versions].sort((a, b) => a.version - b.version);
    for (let at = 1; at < ordered.length; at++) {
      const previous = ordered[at - 1]!;
      const current = ordered[at]!;
      for (const mode of STORED_MODES) {
        if (previous[mode] !== current[mode]) {
          movements.push({
            mode,
            from: previous[mode],
            to: current[mode],
            change: Math.round((current[mode] - previous[mode]) * 100) / 100,
            at: current.at,
            version: current.version,
          });
        }
      }
    }
  }

  return movements.sort((a, b) => b.at.getTime() - a.at.getTime());
}
