import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listCards, draftVersion, liveVersion, findCard } from '../../../../data/rate-cards';
import { diffCardData } from '../../../../changes/diff';
import { canEditDraft } from '../../../../data/workflow';
import DraftBar from '../../../../components/console/DraftBar';

export default async function ConsoleCardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ card: string }>;
}) {
  const { card: cardKey } = await params;
  const card = await findCard(cardKey);
  if (!card) notFound();

  const [cards, draft, live] = await Promise.all([
    listCards(),
    draftVersion(cardKey),
    liveVersion(cardKey),
  ]);

  const outstanding = diffCardData(live.data, draft.data);
  const frozen = !canEditDraft(draft.state);
  const source = cards.find((entry) => entry.key === cardKey)?.source ?? 'dns';

  return (
    <>
      <div className="cardbar">
        {cards.map((entry) => (
          <Link
            key={entry.key}
            href={`/console/${entry.key}/rates`}
            aria-current={entry.key === cardKey ? 'page' : undefined}
          >
            <span className="name">{entry.name}</span>
            <span className="method">
              {(entry.source ?? 'dns') === 'bluedart' ? 'DIRECTIONAL ZONES' : entry.freightMethod}
            </span>
          </Link>
        ))}
      </div>

      <DraftBar
        cardKey={cardKey}
        outstandingCount={outstanding.length}
        frozen={frozen}
        {...(frozen && draft.changeRequestId
          ? { pendingRequestId: draft.changeRequestId.toHexString() }
          : {})}
      />

      <div className="console">
        <nav className="console-rail">
          <div className="group">Base rate card</div>
          {/* The DNS pages price lanes; Bluedart has none, so it gets its own editor. */}
          {source === 'bluedart' ? (
            <Link href={`/console/${cardKey}/bluedart`}>Bluedart rates</Link>
          ) : source === 'ups' ? (
            <Link href={`/console/${cardKey}/ups`}>UPS rates</Link>
          ) : (
            <>
              <Link href={`/console/${cardKey}/rates`}>Lane rates</Link>
              <Link href={`/console/${cardKey}/geography`}>Smart geography</Link>
              <Link href={`/console/${cardKey}/bulk`}>Bulk changes</Link>
              <Link href={`/console/${cardKey}/params`}>Charges &amp; surcharges</Link>
              <Link href={`/console/${cardKey}/tax`}>Tax &amp; charges</Link>
              <Link href={`/console/${cardKey}/ftl`}>FTL rates</Link>
              <Link href={`/console/${cardKey}/network`}>Network &amp; serviceability</Link>
            </>
          )}
          <Link href={`/console/${cardKey}/changes`}>
            Pending changes
            {outstanding.length > 0 && <span className="chip draft count">{outstanding.length}</span>}
          </Link>

          <div className="group">Contracts</div>
          <Link href="/customers">Customers</Link>
          <Link href="/signups">Online signups</Link>
          <Link href="/templates">Rate templates</Link>
          <Link href="/products">Products</Link>
          <Link href="/charges">Charge library</Link>
          <Link href="/offers">Offers</Link>
          <Link href="/coloaders">Co-loaders</Link>

          <div className="group">Money</div>
          <Link href="/money">Wallets &amp; credit</Link>

          <div className="group">Review</div>
          <Link href="/approvals">Approvals</Link>
          <Link href="/calculator">Calculator</Link>

          <div className="group">Help</div>
          <Link href="/glossary">What the terms mean</Link>
        </nav>

        <div className="console-main">
          <div className="inner">{children}</div>
        </div>
      </div>
    </>
  );
}
