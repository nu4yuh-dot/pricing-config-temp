import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser } from '../../auth/session';
import { can } from '../../auth/roles';
import { pendingRequests } from '../../data/rate-cards';
import { pendingProposals, pendingBookingExceptions } from '../../data/customers';
import { signOut } from '../actions';
import NavMenu from '../../components/NavMenu';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const reviewer = can(user.role, 'review-change-request');
  const [queue, proposals, exceptions] = reviewer
    ? await Promise.all([pendingRequests(), pendingProposals(), pendingBookingExceptions()])
    : [[], [], []];
  const waiting = queue.length + proposals.length + exceptions.length;

  return (
    <div className="shell">
      <header className="masthead">
        <h1>DNS Logistics</h1>
        <span className="sub">Pricing configuration</span>
        <nav>
          {/* Grouped by the job somebody came here to do. Rate cards first, because
              that is what this system is for; everything an admin needs to run the
              tool rather than price with it sits at the end. */}
          <NavMenu label="Rate cards">
            <span className="menu-group">Self-network</span>
            <Link href="/console/model-1/rates">Model 1 — cumulative slabs</Link>
            <Link href="/console/model-2/rates">Model 2 — min plus excess</Link>
            <Link href="/console/model-3/rates">Model 3 — max of min or full</Link>
            <span className="menu-group">Partners</span>
            <Link href="/console/bluedart/bluedart">Bluedart</Link>
            <Link href="/console/ups/ups">UPS international</Link>
          </NavMenu>

          <NavMenu label="Customers">
            <Link href="/customers">Contract customers</Link>
            <Link href="/customers/new">Add a customer</Link>
            <Link href="/templates">Rate templates</Link>
            <Link href="/products">Products</Link>
            <Link href="/offers">Offers</Link>
            <Link href="/coloaders">Co-loaders</Link>
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

          {can(user.role, 'record-money') && <Link href="/money">Billing</Link>}

          <Link href="/calculator">Calculator</Link>

          <NavMenu label="Reference">
            <Link href="/pincodes">Pincodes</Link>
            <Link href="/charges">Charge library</Link>
            <Link href="/glossary">What the terms mean</Link>
          </NavMenu>

          {(can(user.role, 'manage-users') || can(user.role, 'view-audit-log')) && (
            <NavMenu label="Admin">
              {can(user.role, 'manage-users') && <Link href="/users">Users</Link>}
              {can(user.role, 'view-audit-log') && <Link href="/history">Activity</Link>}
            </NavMenu>
          )}

          <Link className="whoami" href="/profile">
            {user.name} · {user.role}
          </Link>
          <form action={signOut}>
            <button type="submit">Sign out</button>
          </form>
        </nav>
      </header>
      {children}
    </div>
  );
}
