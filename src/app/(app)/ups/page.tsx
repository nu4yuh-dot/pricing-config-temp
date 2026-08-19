import { notFound } from 'next/navigation';
import Link from 'next/link';
import { currentUser } from '../../../auth/session';
import { liveCardsFromSource } from '../../../data/rate-cards';
import UpsCalculator from '../../../components/console/UpsCalculator';
import CalculatorTabs from '../../../components/CalculatorTabs';

/**
 * The UPS international calculator.
 *
 * Ex-Mumbai to anywhere the agreement zones. Separate from the DNS calculator because the
 * question is different: a country rather than a pincode pair, a product rather than a
 * mode, and a surge fee that follows a region of the world rather than the rate zone.
 */
export default async function UpsPage() {
  const user = await currentUser();
  if (!user) notFound();

  const [card] = await liveCardsFromSource('ups');
  const data = card?.data.ups;

  if (!data) {
    return (
      <div className="page">
        <div className="page-inner">
          <h2>UPS international</h2>
          <CalculatorTabs active="/ups" />
          <div className="panel">
            <div className="empty">
              The UPS card is not loaded on this environment. Build it with{' '}
              <code>python3 scripts/extract_ups.py</code> then{' '}
              <code>npx tsx scripts/build-ups-card.ts</code>, and seed it.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const needsPostal = new Set(data.postalZones.map((entry) => entry.country));
  const destinations = Object.keys(data.zones)
    .map((code) => ({
      code,
      name: data.destinationNames[code] ?? code,
      needsPostal: needsPostal.has(code),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // China is zoned by postal code, so it is not in `zones` at all — it reaches the picker
  // only through the ranges. Without this a shipment to Shanghai has nowhere to be chosen.
  for (const code of needsPostal) {
    if (!data.zones[code]) {
      destinations.push({
        code,
        name: data.destinationNames[code] ?? code,
        needsPostal: true,
      });
    }
  }
  destinations.sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="page">
      <div className="page-inner">
        <h2>UPS international — export from {data.params.origin}</h2>
        <CalculatorTabs active="/ups" />
        <p className="lede">
          The MOVIN / UPS Express Saver agreement. A destination country decides the rate zone;
          a separate region of the world decides the per-kilogram surge; fuel is charged on
          freight and surge together at {(data.params.fuelRate * 100).toFixed(2)}%, and not on the
          accessorials. Rates are the contracted ones plus a{' '}
          {(data.params.margin * 100).toFixed(0)}% margin.
        </p>

        <div className="stats">
          <div className="stat">
            <div className="k">Destinations</div>
            <div className="v">{Object.keys(data.zones).length}</div>
            <div className="sub">{data.postalZones.length} postal ranges for China</div>
          </div>
          <div className="stat">
            <div className="k">Rate zones</div>
            <div className="v">{data.zoneKeys.length}</div>
          </div>
          <div className="stat">
            <div className="k">Chargeable minimum</div>
            <div className="v">{data.params.minChargeableWeight} kg</div>
            <div className="sub">Volumetric divisor {data.params.volumetricDivisor}</div>
          </div>
          <div className="stat">
            <div className="k">Accessorials waived</div>
            <div className="v">{data.accessorials.filter((a) => a.waiver === 1).length}</div>
            <div className="sub">of {data.accessorials.length} negotiated</div>
          </div>
        </div>

        <UpsCalculator
          destinations={destinations}
          accessorials={data.accessorials.map((a) => ({
            id: a.id,
            name: a.name,
            waiver: a.waiver,
          }))}
        />

        <p style={{ color: 'var(--ink-soft)', fontSize: 12 }}>
          The card itself — every zone, every rate step and every accessorial — is on{' '}
          <Link href={`/console/${card.key}/ups`}>the UPS card page</Link>.
        </p>
      </div>
    </div>
  );
}
