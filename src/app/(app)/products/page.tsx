import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUser } from '../../../auth/session';
import { can } from '../../../auth/roles';
import { listProducts } from '../../../data/products';
import { listTemplates } from '../../../data/templates';
import { listCards, draftVersion } from '../../../data/rate-cards';
import { listCustomers } from '../../../data/customers';
import { chargeLibrary } from '../../../domain/charge-library';
import { summariseProduct } from '../../../domain/products';
import NewProductForm from '../../../components/console/NewProductForm';
import { createCatalogProduct } from '../../console-actions';

/**
 * The catalog — what the business sells, as a salesperson would name it.
 *
 * Every other screen here is organised the way the engine stores things: cards, lanes,
 * override cells, contracts. This one is organised the way the conversation goes. A
 * product is a template plus the charges that always ride along plus the coverage it is
 * sold under, and the catalog's job is to show that bundle without the reader having to
 * open three screens and hold the answer in their head.
 *
 * It shows blockers as prominently as contents, because a product is assembled now and
 * applied weeks later, and the gap is where a product pointing at a deleted template or an
 * undefined charge waits.
 */
export default async function ProductCatalogPage() {
  const user = await currentUser();
  if (!user) notFound();

  const [products, templates, cards, customers] = await Promise.all([
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
  const canEdit = can(user.role, 'edit-draft');

  const rows = products.map((product) => ({
    product,
    summary: summariseProduct(
      product,
      templates.find((template) => template.key === product.templateKey) ?? null,
      library,
    ),
  }));
  const ready = rows.filter((row) => row.summary.blockers.length === 0).length;

  // How many customers a segment would actually reach. Counted here rather than promised,
  // because a product offered to a tag nobody carries is a product offered to nobody.
  const reach = (segment: string) =>
    customers.filter((customer) =>
      (customer.tags ?? []).some((tag) => tag.trim().toLowerCase() === segment.trim().toLowerCase()),
    ).length;

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Products</h2>
        <p className="lede">
          A template is a shape — zone-directional surface, flat pan-India. A product is how
          the business actually sells: a template, the charges that always ride along, and
          the segment it is offered to, under one name. It holds no rates of its own, so
          applying one writes terms somebody could have written by hand and they go through
          the same approval as any other negotiation.
        </p>

        <div className="stats">
          <div className="stat">
            <div className="k">In the catalog</div>
            <div className={products.length ? 'v' : 'v muted'}>{products.length}</div>
          </div>
          <div className="stat">
            <div className="k">Ready to apply</div>
            <div className={ready ? 'v' : 'v muted'}>{ready}</div>
            <div className="sub">The rest name something that is missing</div>
          </div>
          <div className="stat">
            <div className="k">Templates to build from</div>
            <div className={templates.length ? 'v' : 'v muted'}>{templates.length}</div>
          </div>
        </div>

        {products.length === 0 ? (
          <div className="panel">
            <div className="empty">
              Nothing in the catalog yet. A product needs a template to price from, so start
              from <Link href="/templates">Rate templates</Link> and name the package here.
            </div>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Priced from</th>
                  <th style={{ textAlign: 'right' }}>Cells</th>
                  <th>Charges it carries</th>
                  <th>Sold for</th>
                  <th>Segment</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ product, summary }) => (
                  <tr key={product.key}>
                    <td>
                      <strong>
                        <Link href={`/products/${product.key}`}>{product.name}</Link>
                      </strong>
                      {product.description && (
                        <div style={{ color: 'var(--ink-soft)', fontSize: 11.5 }}>
                          {product.description}
                        </div>
                      )}
                      {summary.blockers.map((blocker) => (
                        <div key={blocker} className="error" style={{ fontSize: 11.5 }}>
                          {blocker}
                        </div>
                      ))}
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>
                      {summary.templateName ? (
                        <>
                          <Link href={`/templates/${product.templateKey}`}>
                            {summary.templateName}
                          </Link>
                          {summary.baseCardKey && (
                            <div style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>
                              on {summary.baseCardKey}
                            </div>
                          )}
                        </>
                      ) : (
                        <code>{product.templateKey}</code>
                      )}
                    </td>
                    <td className="num">{summary.rateCells}</td>
                    <td>
                      {summary.charges.length === 0 && summary.unknownCharges.length === 0 ? (
                        <span style={{ color: 'var(--ink-faint)' }}>
                          Whatever the card already carries
                        </span>
                      ) : (
                        <>
                          {summary.charges.map((charge) => (
                            <span key={charge.id} className="chip live">
                              {charge.name}
                            </span>
                          ))}{' '}
                          {summary.unknownCharges.map((id) => (
                            <span key={id} className="chip rejected">
                              {id}
                            </span>
                          ))}
                        </>
                      )}
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>
                      {summary.modes ? summary.modes.join(', ') : 'Every mode'}
                    </td>
                    <td className="ref">
                      {product.segment ? (
                        <>
                          {product.segment}
                          <div style={{ color: 'var(--ink-faint)', fontSize: 11.5 }}>
                            {reach(product.segment)} tagged
                          </div>
                        </>
                      ) : (
                        <span style={{ color: 'var(--ink-faint)' }}>nobody</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="two-col" style={{ marginTop: '1.4rem' }}>
          <div className="panel">
            <h3>What a product adds</h3>
            <p>
              A name, a segment, and the charges that are part of the offer rather than part
              of a negotiation. Everything it produces is an ordinary override cell, so
              nothing downstream — diff, approval, pruning, quoting — has to know a product
              was involved.
            </p>
          </div>
          <div className="panel">
            <h3>What it deliberately cannot do</h3>
            <p>
              Hold a rate. A product that could would be a fourth place a price can hide, and
              three is already too many. It also cannot change what a charge costs: attaching
              one switches it on, and the amount stays where the charge is defined.
            </p>
          </div>
        </div>

        {canEdit ? (
          <>
            <h3>Add a product</h3>
            {templates.length === 0 ? (
              <p className="empty">
                There is no template to price a product from yet. Build one on{' '}
                <Link href="/templates">Rate templates</Link> first.
              </p>
            ) : (
              <NewProductForm
                templates={templates.map((template) => ({
                  key: template.key,
                  name: template.name,
                  cells: Object.keys(template.overrides).length,
                }))}
                charges={library.map((charge) => ({ id: charge.id, name: charge.name }))}
                segments={[
                  ...new Set(
                    products
                      .map((product) => product.segment)
                      .filter((segment): segment is string => Boolean(segment)),
                  ),
                ]}
                existingKeys={products.map((product) => product.key)}
                onCreate={async (input) => {
                  'use server';
                  await createCatalogProduct(input);
                }}
              />
            )}
          </>
        ) : (
          <p className="empty">Your role can read the catalog but not add to it.</p>
        )}
      </div>
    </div>
  );
}
