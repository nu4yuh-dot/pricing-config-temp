import { redirect } from 'next/navigation';
import { currentUser } from '../../../auth/session';
import { can } from '../../../auth/roles';
import { listServices, isBuiltIn } from '../../../data/services';
import ServiceForm from '../../../components/console/ServiceForm';
import { saveServiceRecord } from '../../console-actions';

/**
 * Services — what a customer buys, as against the network that carries it.
 *
 * The distinction is the whole point of this screen. A *network* is road, air or rail:
 * there are three with rates, plus NFO derived from air, because that is what the rate
 * cards and all 19,494 pincode records are built around. A *service* is something sold —
 * a network, a multiplier, and a promise about how fast.
 *
 * So services can be added and edited here and networks cannot, and the reason is honest
 * rather than arbitrary: a new service is arithmetic on a tariff that already exists, while
 * a new network would need a rate grid on every card and a zone on every pincode.
 */
export default async function ServicesPage() {
  const user = await currentUser();
  if (!user) redirect('/login');

  const services = await listServices();
  const editable = can(user.role, 'edit-draft');
  const added = services.filter((service) => !isBuiltIn(service.key));

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Services</h2>
        <p className="lede">
          What is on sale. Each service rides one of the networks the engine prices, at a
          multiplier — which is exactly what <strong>next flight out</strong> has always been:
          air, at twice the rate.
        </p>

        <div className="stats">
          <div className="stat">
            <div className="k">On sale</div>
            <div className="v">{services.filter((service) => service.active).length}</div>
          </div>
          <div className="stat">
            <div className="k">Networks</div>
            <div className="v">4</div>
            <div className="sub">Fixed — surface, air, rail, and NFO from air</div>
          </div>
          <div className="stat">
            <div className="k">Added by you</div>
            <div className={added.length ? 'v' : 'v muted'}>{added.length}</div>
          </div>
        </div>

        <div className="gridscroll">
          <table className="data">
            <thead>
              <tr>
                <th>Service</th>
                <th>Rides</th>
                <th style={{ textAlign: 'right' }}>Freight ×</th>
                <th style={{ textAlign: 'right' }}>Transit</th>
                <th>Tax</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {services.map((service) => (
                <tr key={service.key}>
                  <td>
                    <strong>{service.name}</strong>
                    <div className="sub">
                      {service.key}
                      {isBuiltIn(service.key) && ' · built in'}
                    </div>
                  </td>
                  <td>{service.mode}</td>
                  <td className="num">
                    {service.multiplier === 1 ? '—' : `× ${service.multiplier}`}
                  </td>
                  <td className="num">
                    {service.transitAdjustmentDays
                      ? `${service.transitAdjustmentDays > 0 ? '+' : ''}${service.transitAdjustmentDays} d`
                      : '—'}
                  </td>
                  <td>
                    {service.sacCode ?? '—'}
                    {service.gstRate !== undefined && (
                      <div className="sub">{Math.round(service.gstRate * 100)}% GST</div>
                    )}
                  </td>
                  <td>
                    {service.active ? (
                      <span className="chip live">on sale</span>
                    ) : (
                      <span className="chip">withdrawn</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="callout info">
          <strong>A built-in service can be renamed or retaxed, but not removed.</strong> The
          engine prices its network whatever this row says, so deleting it would hide a service
          that still answers.
        </div>

        {editable ? (
          <>
            <h3>Add or edit a service</h3>
            <p className="lede" style={{ marginTop: 0 }}>
              Entering an existing key edits that service. A multiplier applies to freight only —
              never to tax, and never to statutory charges.
            </p>
            <ServiceForm action={saveServiceRecord} />
          </>
        ) : (
          <p className="empty">Your role ({user.role}) is read-only here.</p>
        )}
      </div>
    </div>
  );
}
