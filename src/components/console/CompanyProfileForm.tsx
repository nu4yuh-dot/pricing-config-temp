'use client';

import { useActionState, useState } from 'react';
import {
  saveCustomerProfile,
  saveCommercial,
  type ProfileResult,
  type ActionResult,
} from '../../app/console-actions';
import {
  checkGstin,
  checkPan,
  checkMsme,
  EMPTY_ADDRESS,
  type Address,
  type CompanyProfile,
  type Contact,
  type Plant,
} from '../../domain/company';
import type { CommercialTerms } from '../../domain/customers';
import { useActionToast } from '../Toasts';

/**
 * Company master data.
 *
 * Identifiers are checked as they are typed, and the GSTIN's own contents are shown
 * back — it carries the state and the PAN inside it, so displaying what it decodes to
 * catches a transposed character immediately rather than at invoicing.
 *
 * Plants exist because a customer commonly ships from several sites in different
 * states, each with its own pincode (which decides its zone) and often its own GSTIN.
 */

function AddressFields({
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  value: Address;
  onChange: (next: Address) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  const set = (patch: Partial<Address>) => onChange({ ...value, ...patch });
  return (
    <div className="inline-form" style={{ marginBottom: 0 }}>
      <div className="field" style={{ minWidth: 220 }}>
        <label htmlFor={`${idPrefix}-line1`}>Address</label>
        <input id={`${idPrefix}-line1`} value={value.line1} disabled={disabled}
          onChange={(e) => set({ line1: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-city`}>City</label>
        <input id={`${idPrefix}-city`} value={value.city} disabled={disabled}
          onChange={(e) => set({ city: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-state`}>State</label>
        <input id={`${idPrefix}-state`} value={value.state} disabled={disabled}
          onChange={(e) => set({ state: e.target.value })} />
      </div>
      <div className="field" style={{ maxWidth: 110 }}>
        <label htmlFor={`${idPrefix}-pin`}>Pincode</label>
        <input id={`${idPrefix}-pin`} value={value.pincode || ''} disabled={disabled}
          onChange={(e) => set({ pincode: Number(e.target.value) || 0 })} />
      </div>
    </div>
  );
}

export default function CompanyProfileForm({
  code,
  profile,
  commercial,
  canEdit,
}: {
  code: string;
  profile: CompanyProfile;
  commercial: CommercialTerms;
  canEdit: boolean;
}) {
  const [draft, setDraft] = useState<CompanyProfile>(profile);
  const [profileState, profileAction, profilePending] = useActionState(
    saveCustomerProfile,
    null as ProfileResult | null,
  );
  const [termsState, termsAction, termsPending] = useActionState(
    saveCommercial,
    null as ActionResult | null,
  );
  useActionToast(profileState, { what: 'Company profile', verb: 'save the profile' });
  useActionToast(termsState, { what: 'Commercial terms', verb: 'save the commercial terms' });

  const gst = draft.gstin ? checkGstin(draft.gstin) : null;
  const pan = draft.pan ? checkPan(draft.pan) : null;
  const msme = draft.msmeNumber ? checkMsme(draft.msmeNumber) : null;

  const set = (patch: Partial<CompanyProfile>) => setDraft({ ...draft, ...patch });

  const addPlant = () =>
    set({
      plants: [
        ...draft.plants,
        {
          code: `PLANT-${draft.plants.length + 1}`,
          name: '',
          address: { ...EMPTY_ADDRESS },
          active: true,
        },
      ],
    });

  const setPlant = (index: number, patch: Partial<Plant>) =>
    set({ plants: draft.plants.map((p, i) => (i === index ? { ...p, ...patch } : p)) });

  /**
   * Remove a plant outright.
   *
   * A plant that has simply stopped shipping should be marked inactive instead — that
   * keeps its address and GSTIN against the shipments it did send. Removal is for one
   * added by mistake, so it asks first when there is anything to lose.
   */
  const removePlant = (index: number) => {
    const plant = draft.plants[index];
    const named = plant?.name?.trim() || plant?.code || 'this plant';
    const hasContent = Boolean(
      plant && (plant.name?.trim() || plant.gstin?.trim() || plant.address?.pincode),
    );
    if (hasContent && !confirm(`Remove ${named}? Untick Active instead to keep it on record.`)) {
      return;
    }
    set({ plants: draft.plants.filter((_, i) => i !== index) });
  };

  const addContact = () =>
    set({ contacts: [...draft.contacts, { name: '', role: '' }] });

  const setContact = (index: number, patch: Partial<Contact>) =>
    set({ contacts: draft.contacts.map((c, i) => (i === index ? { ...c, ...patch } : c)) });

  return (
    <>
      <div className="panel">
        <header>
          <h3>Company details</h3>
          <span className="hint">Who the customer is — not versioned, cannot change a price</span>
        </header>
        <form action={profileAction}>
          <input type="hidden" name="code" value={code} />
          <input type="hidden" name="profile" value={JSON.stringify(draft)} />
          <div className="body">
            {profileState?.error && <div className="error">{profileState.error}</div>}
            {profileState?.ok && (profileState.warnings?.length ?? 0) === 0 && (
              <div className="callout info" style={{ marginTop: 0 }}>
                {profileState.submitted === false ? (
                  'Nothing had changed, so there is nothing to review.'
                ) : (
                  <>
                    <strong>Sent for approval.</strong> These details are unchanged until an
                    admin accepts them
                    {(profileState.changed?.length ?? 0) > 0 && (
                      <> — they will be reviewing {profileState.changed?.join(', ')}</>
                    )}
                    . Once accepted, they are also sent to the SameX core.
                  </>
                )}
              </div>
            )}
            {(profileState?.warnings?.length ?? 0) > 0 && (
              <div className="callout">
                <strong>Sent for approval, but these do not agree</strong>
                <ul>{profileState?.warnings?.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </div>
            )}

            <div className="inline-form">
              <div className="field" style={{ minWidth: 240 }}>
                <label htmlFor="cp-legal">Legal name</label>
                <input id="cp-legal" value={draft.legalName} disabled={!canEdit}
                  onChange={(e) => set({ legalName: e.target.value })} />
              </div>
              <div className="field" style={{ minWidth: 200 }}>
                <label htmlFor="cp-trade">Trade name</label>
                <input id="cp-trade" value={draft.tradeName ?? ''} disabled={!canEdit}
                  onChange={(e) => set({ tradeName: e.target.value })} />
              </div>
            </div>

            <div className="inline-form">
              <div className="field" style={{ minWidth: 190 }}>
                <label htmlFor="cp-gstin">GSTIN</label>
                <input id="cp-gstin" value={draft.gstin ?? ''} disabled={!canEdit}
                  placeholder="27ABCDE1234F1Z5"
                  onChange={(e) => set({ gstin: e.target.value.toUpperCase() })} />
              </div>
              <div className="field" style={{ minWidth: 150 }}>
                <label htmlFor="cp-pan">PAN</label>
                <input id="cp-pan" value={draft.pan ?? ''} disabled={!canEdit}
                  placeholder="ABCDE1234F"
                  onChange={(e) => set({ pan: e.target.value.toUpperCase() })} />
              </div>
              <div className="field" style={{ minWidth: 200 }}>
                <label htmlFor="cp-msme">MSME / Udyam</label>
                <input id="cp-msme" value={draft.msmeNumber ?? ''} disabled={!canEdit}
                  placeholder="UDYAM-MH-26-0123456"
                  onChange={(e) => set({ msmeNumber: e.target.value.toUpperCase() })} />
              </div>
            </div>

            {/* Decode the GSTIN back, so a wrong character is obvious at once. */}
            <div style={{ fontSize: 11.5, marginBottom: 12 }}>
              {gst && (
                <div style={{ color: gst.valid ? 'var(--approved)' : 'var(--rejected)' }}>
                  GSTIN: {gst.valid
                    ? `valid — registered in ${gst.stateName}, PAN ${gst.pan}`
                    : gst.problem}
                </div>
              )}
              {pan && (
                <div style={{ color: pan.valid ? 'var(--approved)' : 'var(--rejected)' }}>
                  PAN: {pan.valid ? 'valid' : pan.problem}
                </div>
              )}
              {msme && (
                <div style={{ color: msme.valid ? 'var(--approved)' : 'var(--rejected)' }}>
                  Udyam: {msme.valid ? 'valid' : msme.problem}
                </div>
              )}
            </div>

            <h3 style={{ marginTop: 4 }}>Registered address</h3>
            <AddressFields idPrefix="cp-reg" disabled={!canEdit}
              value={draft.registeredAddress ?? EMPTY_ADDRESS}
              onChange={(registeredAddress) => set({ registeredAddress })} />

            <h3>Contacts</h3>
            {draft.contacts.map((contact, index) => (
              <div className="inline-form" key={index}>
                <div className="field"><label>Name</label>
                  <input value={contact.name} disabled={!canEdit}
                    onChange={(e) => setContact(index, { name: e.target.value })} /></div>
                <div className="field"><label>Role</label>
                  <input value={contact.role} disabled={!canEdit} placeholder="Logistics Head"
                    onChange={(e) => setContact(index, { role: e.target.value })} /></div>
                <div className="field"><label>Email</label>
                  <input value={contact.email ?? ''} disabled={!canEdit}
                    onChange={(e) => setContact(index, { email: e.target.value })} /></div>
                <div className="field"><label>Phone</label>
                  <input value={contact.phone ?? ''} disabled={!canEdit}
                    onChange={(e) => setContact(index, { phone: e.target.value })} /></div>
              </div>
            ))}
            {canEdit && <button type="button" onClick={addContact}>Add a contact</button>}

            <h3>Plants ({draft.plants.length})</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 11.5, marginTop: 0 }}>
              A plant&rsquo;s pincode decides which zone it prices from, so each shipping site needs
              its own. A plant in another state usually has its own GSTIN.
            </p>
            {draft.plants.map((plant, index) => (
              <div key={index} style={{ borderLeft: '3px solid var(--rule-strong)', paddingLeft: 12, marginBottom: 14 }}>
                <div className="inline-form">
                  <div className="field" style={{ maxWidth: 130 }}><label>Code</label>
                    <input value={plant.code} disabled={!canEdit}
                      onChange={(e) => setPlant(index, { code: e.target.value.toUpperCase() })} /></div>
                  <div className="field" style={{ minWidth: 200 }}><label>Plant name</label>
                    <input value={plant.name} disabled={!canEdit}
                      onChange={(e) => setPlant(index, { name: e.target.value })} /></div>
                  <div className="field" style={{ minWidth: 180 }}><label>GSTIN (if different)</label>
                    <input value={plant.gstin ?? ''} disabled={!canEdit}
                      onChange={(e) => setPlant(index, { gstin: e.target.value.toUpperCase() })} /></div>
                  <div className="field"><label>Active</label>
                    <input type="checkbox" checked={plant.active} disabled={!canEdit}
                      onChange={(e) => setPlant(index, { active: e.target.checked })} /></div>
                  {canEdit && (
                    <div className="field">
                      <label>&nbsp;</label>
                      <button
                        type="button"
                        onClick={() => removePlant(index)}
                        title="Remove this plant. To keep it on record, untick Active instead."
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
                <AddressFields idPrefix={`plant-${index}`} disabled={!canEdit}
                  value={plant.address}
                  onChange={(address) => setPlant(index, { address })} />
                {plant.gstin && (() => {
                  const check = checkGstin(plant.gstin);
                  return (
                    <div style={{ fontSize: 11, marginTop: 6, color: check.valid ? 'var(--approved)' : 'var(--rejected)' }}>
                      {check.valid ? `Registered in ${check.stateName}` : check.problem}
                    </div>
                  );
                })()}
              </div>
            ))}
            {canEdit && <button type="button" onClick={addPlant}>Add a plant</button>}
          </div>

          {canEdit && (
            <div className="actionbar">
              <span className="spacer" />
              <button className="primary" type="submit" disabled={profilePending}>
                {profilePending ? 'Sending…' : 'Send company details for approval'}
              </button>
            </div>
          )}
        </form>
      </div>

      <div className="panel">
        <header>
          <h3>Commercial terms</h3>
          <span className="hint">Billing type and GST DO change what a quote shows</span>
        </header>
        <form action={termsAction}>
          <input type="hidden" name="code" value={code} />
          <div className="body">
            {termsState?.ok && <div className="callout info" style={{ marginTop: 0 }}>Saved.</div>}
            <div className="inline-form">
              <div className="field">
                <label htmlFor="ct-billing">Billing type</label>
                <select id="ct-billing" name="billingType" defaultValue={commercial.billingType} disabled={!canEdit}>
                  <option value="FORWARD">Forward charge — we bill GST</option>
                  <option value="RCM">Reverse charge (RCM) — customer accounts for GST</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="ct-gst">GST applicable</label>
                <input id="ct-gst" name="gstApplicable" type="checkbox"
                  defaultChecked={commercial.gstApplicable} disabled={!canEdit} />
              </div>
              <div className="field" style={{ maxWidth: 130 }}>
                <label htmlFor="ct-days">Payment terms (days)</label>
                <input id="ct-days" name="paymentTermsDays" defaultValue={commercial.paymentTermsDays} disabled={!canEdit} />
              </div>
              <div className="field" style={{ maxWidth: 160 }}>
                <label htmlFor="ct-credit">Credit limit (₹)</label>
                <input id="ct-credit" name="creditLimit" defaultValue={commercial.creditLimit ?? ''} disabled={!canEdit} />
              </div>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', margin: 0 }}>
              Under reverse charge, or where GST is not applicable, quotes for this customer show no
              GST and say why. Payment terms and credit limit are held for reference — wallets,
              invoices and credit enforcement belong to the booking platform.
            </p>
          </div>
          {canEdit && (
            <div className="actionbar">
              <span className="spacer" />
              <button className="primary" type="submit" disabled={termsPending}>
                {termsPending ? 'Saving…' : 'Save commercial terms'}
              </button>
            </div>
          )}
        </form>
      </div>
    </>
  );
}
