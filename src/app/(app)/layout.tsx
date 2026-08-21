import { redirect } from 'next/navigation';
import ToastProvider from '../../components/Toasts';
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
    <ToastProvider>
    <div className="shell">
      <header className="masthead">
        <h1>DNS Logistics</h1>
        <span className="sub">Pricing configuration</span>
        <nav>
          {/* Grouped by the job somebody came here to do, not by which screen was built
              first. Pricing is everything that decides a number; Customers is who we
              charge; Billing is money that has moved; the rest is reference and running
              the tool. */}
          <NavMenu label="Pricing" badge={waiting}>
            {/* One way in. Which card you are on is a choice you keep making while you
                work, so it belongs in the side rail beside the card's own pages, not in a
                menu you have to reopen every time. */}
            <Link href="/console/model-1/rates">Rate cards</Link>
            <Link href="/calculator">Calculator</Link>
            <Link href="/templates">Rate templates</Link>
            <Link href="/offers">Offers</Link>
            <Link href="/charges">Charge library</Link>
            <span className="menu-group">The network</span>
            <Link href="/carriers">Carriers</Link>
            <Link href="/services">Services</Link>
            <span className="menu-group">Records</span>
            <Link href="/audit">Rate audit</Link>
            <Link href="/fuel">Fuel index</Link>
            <span className="menu-group">Review</span>
            <Link href="/approvals">
              Approvals
              {waiting > 0 && (
                <>
                  {' '}
                  <span className="chip pending count">{waiting}</span>
                </>
              )}
            </Link>
          </NavMenu>

          <NavMenu label="Customers">
            {/* The master comes first: it is now the source of truth for who a customer is,
                not only for what they pay. The core's own customer pages are being retired
                in favour of it. */}
            <Link href="/customers">Customer master</Link>
            <Link href="/customers/new">Add a customer</Link>
            <span className="menu-group">Reference</span>
            <Link href="/products">Products</Link>
            <Link href="/coloaders">Co-loaders</Link>
          </NavMenu>

          {can(user.role, 'record-money') && (
            <NavMenu label="Billing">
              {/* Ordered as the month runs: what a period covered, what was invoiced for
                  it, what came back. */}
              <Link href="/periods">Billing periods</Link>
              <Link href="/invoices">Invoices</Link>
              <Link href="/collections">Collections</Link>
              <span className="menu-group">Account</span>
              <Link href="/money">Wallets &amp; credit</Link>
              <Link href="/settlement">Payment terms</Link>
            </NavMenu>
          )}

          <NavMenu label="Reference">
            <Link href="/pincodes">Pincodes</Link>
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
    </ToastProvider>
  );
}
