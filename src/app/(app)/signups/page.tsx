import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUser } from '../../../auth/session';
import { can } from '../../../auth/roles';
import { listSignups } from '../../../data/signups';
import { listProducts } from '../../../data/products';
import { listTemplates } from '../../../data/templates';
import { listCards, draftVersion } from '../../../data/rate-cards';
import { listCustomers } from '../../../data/customers';
import { chargeLibrary } from '../../../domain/charge-library';
import { summariseProduct } from '../../../domain/products';
import { suggestProduct, CHANNEL_LABELS, MANUAL_REVIEW_VOLUME } from '../../../domain/signups';
import SignupQueue from '../../../components/console/SignupQueue';

/**
 * Signups from the website, waiting for somebody to say what they are sold.
 *
 * Everything on the form was already typed by the person signing up, so this screen asks
 * one question rather than repeating theirs. It is a queue and not an inbox: nothing here
 * can book anything until a person has activated it.
 */
export default async function SignupsPage() {
  const user = await currentUser();
  if (!user) notFound();

  const [signups, products, templates, cards, customers] = await Promise.all([
    listSignups('waiting'),
    listProducts(),
    listTemplates(),
    listCards(),
    listCustomers(),
  ]);
  const drafts = await Promise.all(cards.map((card) => draftVersion(card.key)));
  const library = chargeLibrary(
    drafts.map((draft) => draft.data),
    customers.map((customer) => customer.liveTerms.overrides),
  );

  const recent = (await listSignups()).filter((signup) => signup.status !== 'waiting').slice(0, 10);

  const rows = signups.map((signup) => {
    const suggestion = suggestProduct(signup, products);
    return {
      reference: signup.reference,
      legalName: signup.legalName,
      signedUpAt: new Date(signup.signedUpAt).toLocaleString('en-IN'),
      channelLabel: CHANNEL_LABELS[signup.channel],
      declaredVolume: signup.declaredVolume ?? null,
      gstin: signup.gstin ?? null,
      addressLine: signup.addressLine ?? null,
      suggestedProductKey: suggestion.productKey,
      suggestionReason: suggestion.reason,
      flagged: suggestion.flagged,
    };
  });

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Online signups</h2>
        <p className="lede">
          Somebody who signed up on the website has already typed their identity in, so this asks
          one question rather than repeating theirs: which product are they on. The suggestion
          comes from what they said they sell, and it is a suggestion — nothing activates itself,
          because a dropdown answer is a fair guess about a price list and not a decision.
        </p>

        {can(user.role, 'edit-draft') ? (
          <SignupQueue
            signups={rows}
            products={products.map((product) => ({
              key: product.key,
              name: product.name,
              segment: product.segment ?? null,
              // A product naming a missing template or an undefined charge would write
              // terms nobody intended, and a self-serve account is the worst place to
              // discover that.
              blocked:
                summariseProduct(
                  product,
                  templates.find((template) => template.key === product.templateKey) ?? null,
                  library,
                ).blockers.length > 0,
            }))}
            cards={cards
              .filter((card) => (card.source ?? 'dns') === 'dns')
              .map((card) => ({ key: card.key, name: card.name }))}
          />
        ) : (
          <p className="empty">Your role can see the queue but not activate from it.</p>
        )}

        <div className="two-col" style={{ marginTop: '1.4rem' }}>
          <div className="panel">
            <h3>What the rules do</h3>
            <p>
              An answer about what somebody sells points at a segment — own website, marketplace,
              local shop — and the catalog decides what is currently sold to that segment. Naming
              products in the rules would mean editing code every time the catalog changed.
            </p>
          </div>
          <div className="panel">
            <h3>What they refuse to do</h3>
            <p>
              Above {MANUAL_REVIEW_VOLUME.toLocaleString('en-IN')} shipments a month, no suggestion
              is offered. The guess is no worse at that size; the stake is. Rack rates by default
              would sell at list price to somebody who was about to negotiate.
            </p>
          </div>
        </div>

        {recent.length > 0 && (
          <>
            <h3>Recently decided</h3>
            <table className="data">
              <tbody>
                {recent.map((signup) => (
                  <tr key={signup.reference}>
                    <td className="ref">{signup.reference}</td>
                    <td>{signup.legalName}</td>
                    <td>
                      {signup.status === 'activated' ? (
                        <>
                          <span className="chip live">activated</span>{' '}
                          {signup.customerCode && (
                            <Link href={`/customers/${encodeURIComponent(signup.customerCode)}`}>
                              {signup.customerCode}
                            </Link>
                          )}
                        </>
                      ) : (
                        <span className="chip rejected">declined</span>
                      )}
                    </td>
                    <td style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                      {signup.decidedBy} ·{' '}
                      {signup.decidedAt ? new Date(signup.decidedAt).toLocaleDateString('en-IN') : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
