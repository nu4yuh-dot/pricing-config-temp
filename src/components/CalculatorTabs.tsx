import Link from 'next/link';

/**
 * The three calculators, side by side.
 *
 * They ask genuinely different questions — a pincode pair against three DNS models, a
 * destination and weight against Bluedart's four services, a country and product against
 * the UPS agreement — so they stay three screens rather than one form pretending to be
 * general. What they share is the job: what does this shipment cost.
 *
 * Real links rather than client-side tabs, because each of these is worth bookmarking
 * and worth linking somebody to.
 */

const TABS: { href: string; label: string; hint: string }[] = [
  { href: '/calculator', label: 'Self-network', hint: 'Models 1–3, priced together' },
  { href: '/bluedart', label: 'Bluedart', hint: 'Franchise, ex-Pune' },
  { href: '/ups', label: 'UPS international', hint: 'Export, ex-Mumbai' },
];

export default function CalculatorTabs({ active }: { active: '/calculator' | '/bluedart' | '/ups' }) {
  return (
    <div className="subtabs" role="tablist">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          role="tab"
          aria-selected={tab.href === active}
          title={tab.hint}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
