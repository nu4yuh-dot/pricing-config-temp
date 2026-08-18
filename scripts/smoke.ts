/**
 * End-to-end smoke test against a running server and a seeded database.
 *
 * Mints a real session cookie with the app's own signing secret, then fetches every
 * page and asserts the response contains data that could only have come from the
 * database and the pricing engine.
 *
 *   npx tsx scripts/smoke.ts [--base http://127.0.0.1:3000]
 */

import { SignJWT } from 'jose';

const base = (() => {
  const index = process.argv.indexOf('--base');
  return index > -1 ? (process.argv[index + 1] as string) : 'http://127.0.0.1:3000';
})();

const secretValue = process.env.SESSION_SECRET;
if (!secretValue) throw new Error('SESSION_SECRET must be set to mint a test session.');
const secret = new TextEncoder().encode(secretValue);

interface Check {
  path: string;
  label: string;
  /** Strings that must appear in the rendered HTML. */
  expect: string[];
}

const CHECKS: Check[] = [
  {
    path: '/sheets/model-1/surface',
    label: 'Surface Rates grid, Model 1',
    // 530 is the PNQ->NCR minimum charge; J5 addressing must survive; tab strip present.
    expect: ['Surface Rates', 'MINIMUM CHARGE', '530', 'PNQ', 'GAU', 'HOW TO READ', 'Rail Rates'],
  },
  {
    path: '/sheets/model-3/air',
    label: 'Air Rates grid, Model 3',
    expect: ['Air Rates', 'MAX_MIN_OR_FULL', 'PER KG', 'BOM'],
  },
  {
    path: '/sheets/model-1/charges',
    label: 'Charges & Terms',
    expect: ['Fuel Surface', 'GST Air', 'NFO multiplier', 'Rail heavy-package threshold'],
  },
  {
    path: '/sheets/model-1/edl-matrix',
    label: 'EDL matrix',
    expect: ['Min km', '550', 'Rate per km'],
  },
  {
    path: '/sheets/model-1/cluster-guide',
    label: 'Cluster guide',
    expect: ['(21)', 'AIR HUBS (12)'],
  },
  {
    path: '/sheets/model-1/all-in-quote',
    label: 'All-In Quote (derived, with the defect note)',
    expect: ['wrong in the source workbooks', 'Model 1'],
  },
  {
    // Model 1 Surface PNQ->NCR 200kg is the verified golden case: total 5197.50.
    path: '/calculator?mode=surface&from=411001&to=110001&weight=200',
    label: 'Calculator, all three cards',
    expect: ['5,197.50', '5,131.90', '4,830.00', 'Lowest total', 'PNQ', 'NCR', '200 kg'],
  },
  {
    path: '/calculator?mode=air&from=411001&to=400001&weight=200',
    label: 'Calculator, unavailable air lane',
    expect: ['does not serve'],
  },
  {
    path: '/approvals',
    label: 'Unified approvals queue',
    expect: [
      'Waiting on you',
      'Rate card changes',
      'Contract proposals',
      'Booking exceptions',
    ],
  },
  {
    path: '/pincodes?q=411001',
    label: 'Pincode search',
    expect: ['411001', 'Pincode Master', 'PNQ'],
  },
  { path: '/users', label: 'Users', expect: ['admin@dnslogistic.com', 'Configurator', 'Roles'] },

  // Console — the second interface. Same data, different way in.
  {
    path: '/console/model-1/rates',
    label: 'Console lane editor',
    expect: ['Lane rates', 'Choose a lane', 'Do we carry this lane', 'What this lane quotes', 'Browse every lane', '530'],
  },
  {
    path: '/console/model-1/bulk',
    label: 'Console bulk changes',
    expect: ['Change many lanes at once', 'Increase by', 'would change'],
  },
  {
    path: '/console/model-1/params',
    label: 'Console charges',
    expect: ['Fuel, surface', 'Fuel, FTL', 'NFO multiplier', 'Weight rules'],
  },
  {
    path: '/sheets/model-1/tax-charges',
    label: 'Tax & Charges tab',
    // Ampersands arrive HTML-escaped, so the assertion has to match the markup.
    expect: ['TAX &amp; CHARGES', '9965', '9968', 'Reverse charge', 'CHARGE MENU', 'ODA / EDL surcharge'],
  },
  {
    path: '/console/model-1/tax',
    label: 'Console tax & charges',
    expect: ['Tax &amp; charges', 'GST by mode', 'Charge menu', 'from the pincode distance', 'Docket'],
  },
  {
    // The charge lines, the fuel base in words and the SAC now appear on a quote.
    path: '/calculator?mode=surface&from=411001&to=110001&weight=200',
    label: 'Calculator shows the settlement detail',
    expect: ['on freight + pickup + delivery + ODA', 'SAC 9965', 'Docket'],
  },
  {
    path: '/sheets/model-1/ftl-rates',
    label: 'FTL Rates tab',
    expect: ['FULL TRUCK LOAD', 'TRAILER · 40 FT', 'up to 25,000 kg', 'From\\To', 'PNQ'],
  },
  {
    path: '/console/model-1/ftl',
    label: 'Console FTL rates',
    expect: ['FTL rates', 'Choose a truck and a lane', 'Trip price', 'hired whole', '25,000 kg'],
  },
  {
    path: '/sheets/bluedart/bluedart-rates',
    label: 'Bluedart Rates tab',
    expect: ['BLUEDART FRANCHISE RATE CARD', 'NE &amp; REMOTE', 'DOCs / 500 g', 'First 5 kg', '417.50'],
  },
  {
    path: '/console/bluedart/bluedart',
    label: 'Console Bluedart rates',
    expect: ['Bluedart rates', 'WEST — DOCs', 'APEX — air, premium', 'Fuel — surface'],
  },
  {
    // NORTH surface 30 kg = 165 + 15x14 + 5x13.5 = 442.50 freight, 1,215.5475 landed.
    path: '/bluedart?to=110001&weight=30&value=5000',
    label: 'Bluedart calculator',
    expect: ['Bluedart calculator', 'NORTH', '442.50', '1,215.55', 'SAC 9968'],
  },
  {
    path: '/console/model-1/network',
    label: 'Console network coverage',
    expect: ['Network', 'of lanes carried', 'coverage'],
  },
  {
    path: '/customers',
    label: 'Customers list',
    // Deliberately not asserting a particular customer: which ones exist differs
    // between a local database and a deployment.
    expect: ['Contract customers', 'Negotiated cells', 'Contract covers'],
  },
  { path: '/history', label: 'History', expect: ['Rate card versions', 'Audit log', 'CUMULATIVE'] },
  {
    // The money panel renders for a customer with no ledger at all, which is the state
    // every customer starts in.
    path: '/customers',
    label: 'Customers list still loads with billing in place',
    expect: ['Contract customers'],
  },
];

async function main(): Promise<void> {
  const token = await new SignJWT({
    email: 'admin@dnslogistic.com',
    name: 'Admin',
    role: 'admin',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('000000000000000000000001')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);

  const cookie = `dns_pricing_session=${token}`;
  let failures = 0;

  for (const check of CHECKS) {
    const response = await fetch(`${base}${check.path}`, { headers: { cookie } });
    // React emits `<!-- -->` between adjacent text nodes, so `{value} kg` arrives as
    // `200<!-- --> kg`. Strip those markers before matching on visible text.
    const html = (await response.text()).replaceAll('<!-- -->', '');

    const missing = check.expect.filter((needle) => !html.includes(needle));
    const ok = response.status === 200 && missing.length === 0;
    if (!ok) failures++;

    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${String(response.status)}  ${check.label}` +
        (missing.length > 0 ? `\n        missing: ${missing.join(' | ')}` : ''),
    );
  }

  // An anonymous request must be redirected, never served.
  const anonymous = await fetch(`${base}/sheets/model-1/surface`, { redirect: 'manual' });
  const redirected = anonymous.status === 307 || anonymous.status === 302;
  if (!redirected) failures++;
  console.log(
    `${redirected ? 'PASS' : 'FAIL'}  ${anonymous.status}  anonymous access is redirected to sign-in`,
  );

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('smoke run failed:', error);
  process.exit(1);
});
