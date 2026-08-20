import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listCards, draftVersion, liveVersion, findCard } from '../../../../data/rate-cards';
import { diffCardData } from '../../../../changes/diff';
import { canEditDraft } from '../../../../data/workflow';
import { consoleHomeFor } from '../../../../console/card-home';
import { pickerLabel, orderForPicker } from '../../../../console/card-picker';
import { sheetSpecsForSource } from '../../../../sheets/specs';
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
  // `findCard` normalises the legacy `product` field, so this is the card's real source.
  const source = card.source ?? 'dns';

  // The sheet view opens on a tab this card actually has. Surface Rates is the one people
  // reach for on a DNS card; a card with no grid at all gets no toggle.
  const tabs = sheetSpecsForSource(source, draft.data);
  const firstTab = tabs.find((tab) => tab.id === 'surface') ?? tabs.find((tab) => !tab.derived);
  const toggleHref = firstTab ? `/sheets/${cardKey}/${firstTab.id}` : undefined;

  return (
    <>
      <DraftBar
        cardKey={cardKey}
        cardName={card.name}
        {...(toggleHref === undefined ? {} : { toggleHref })}
        outstandingCount={outstanding.length}
        frozen={frozen}
        {...(frozen && draft.changeRequestId
          ? { pendingRequestId: draft.changeRequestId.toHexString() }
          : {})}
      />

      <div className="console">
        {/* Which card, then what about it. Card switching lives here rather than in the
            masthead because it is a choice you keep making while you work — a menu you
            have to reopen for every switch is a menu you fight. Everything else —
            customers, approvals, money, reference — stays in the masthead. */}
        <nav className="console-rail">
          <div className="group">Rate cards</div>
          {orderForPicker(cards).map((entry) => (
            <Link
              key={entry.key}
              href={consoleHomeFor(entry.source ?? 'dns', entry.key)}
              aria-current={entry.key === cardKey ? 'page' : undefined}
              title={entry.name}
            >
              {pickerLabel(entry.name)}
            </Link>
          ))}

          <div className="group">{card.name}</div>
          {/* The DNS pages price lanes; Bluedart has none, so it gets its own editor. */}
          {source === 'bluedart' ? (
            <Link href={`/console/${cardKey}/bluedart`}>Bluedart rates</Link>
          ) : source === 'ups' ? (
            <Link href={`/console/${cardKey}/ups`}>UPS rates</Link>
          ) : (
            <>
              <Link href={`/console/${cardKey}/rates`}>Lane rates</Link>
              <Link href={`/console/${cardKey}/geography`}>Smart geography</Link>
              <Link href={`/console/${cardKey}/bulk`}>Bulk changes &amp; discounts</Link>
              <Link href={`/console/${cardKey}/params`}>Charges &amp; surcharges</Link>
              <Link href={`/console/${cardKey}/cartage`}>Cartage by zone</Link>
              <Link href={`/console/${cardKey}/oda`}>ODA &amp; EDL matrix</Link>
              <Link href={`/console/${cardKey}/tax`}>Tax &amp; charges</Link>
              <Link href={`/console/${cardKey}/transit`}>Transit times</Link>
              <Link href={`/console/${cardKey}/ftl`}>FTL rates</Link>
              <Link href={`/console/${cardKey}/network`}>Network &amp; serviceability</Link>
            </>
          )}
          <Link href={`/console/${cardKey}/changes`}>
            Pending changes
            {outstanding.length > 0 && <span className="chip draft count">{outstanding.length}</span>}
          </Link>
        </nav>

        <div className="console-main">
          <div className="inner">{children}</div>
        </div>
      </div>
    </>
  );
}
