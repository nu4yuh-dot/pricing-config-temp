import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { currentUser } from '../../auth/session';
import { can } from '../../auth/roles';
import { pendingRequests } from '../../data/rate-cards';
import { pendingProposals, pendingBookingExceptions } from '../../data/customers';
import { signOut } from '../actions';
import UiSwitch from '../../components/console/UiSwitch';
import NavMenu from '../../components/NavMenu';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const reviewer = can(user.role, 'review-change-request');
  const [queue, proposals, exceptions] = reviewer
    ? await Promise.all([pendingRequests(), pendingProposals(), pendingBookingExceptions()])
    : [[], [], []];
  const waiting = queue.length + proposals.length + exceptions.length;

  // Which interface this person last chose. Both reach the same data.
  const mode = ((await cookies()).get('ui_mode')?.value === 'sheet' ? 'sheet' : 'console') as
    | 'sheet'
    | 'console';

  return (
    <div className="shell">
      <header className="masthead">
        <h1>DNS Logistics</h1>
        <span className="sub">Pricing configuration</span>
        <nav>
          {/* Grouped by what somebody is doing, not by which screen was built first.
              Nothing is removed: every page reachable before is reachable here. */}
          <NavMenu label="Customers">
            <Link href="/customers">Contract customers</Link>
            <Link href="/customers/new">Add a customer</Link>
            <Link href="/signups">Online signups</Link>
            <Link href="/coloaders">Co-loaders</Link>
          </NavMenu>

          <NavMenu label="Contracts">
            <Link href={mode === 'sheet' ? '/sheets/model-1/surface' : '/console/model-1/rates'}>
              Base rate cards
            </Link>
            <Link href="/templates">Rate templates</Link>
            <Link href="/products">Products</Link>
            <Link href="/charges">Charge library</Link>
            <Link href="/offers">Offers</Link>
          </NavMenu>

          <Link href="/approvals">
            Approvals
            {waiting > 0 && (
              <>
                {' '}
                <span className="chip pending count">{waiting}</span>
              </>
            )}
          </Link>

          <Link href="/money">Money</Link>

          <NavMenu label="Tools">
            <Link href="/calculator">Calculator</Link>
            <Link href="/bluedart">Bluedart</Link>
            <Link href="/ups">UPS international</Link>
            <Link href="/pincodes">Pincodes</Link>
            <Link href="/glossary">What the terms mean</Link>
            {can(user.role, 'manage-users') && <Link href="/users">Users</Link>}
            {can(user.role, 'view-audit-log') && <Link href="/history">History</Link>}
          </NavMenu>

          <UiSwitch mode={mode} cardKey="model-1" />
          <span className="whoami">
            {user.name} · {user.role}
          </span>
          <form action={signOut}>
            <button type="submit">Sign out</button>
          </form>
        </nav>
      </header>
      {children}
    </div>
  );
}
