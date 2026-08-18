/**
 * Company master data for a contract customer.
 *
 * Modelled on what an Indian B2B logistics contract actually needs: a GSTIN per
 * registration (a company registered in several states holds several), a PAN, an
 * MSME/Udyam number where applicable, and one or more plants that ship
 * independently — which is why plants carry their own address and GSTIN rather than
 * inheriting the company's.
 */

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: number;
  country: string;
}

export const EMPTY_ADDRESS: Address = {
  line1: '',
  city: '',
  state: '',
  pincode: 0,
  country: 'India',
};

export interface Contact {
  name: string;
  /** "Logistics Head", "Accounts Payable" — who to go to for what. */
  role: string;
  email?: string;
  phone?: string;
}

/**
 * A shipping location.
 *
 * A single customer commonly ships from several plants in different states. Each
 * needs its own address (so its pincode resolves to the right zone) and often its
 * own GSTIN, because GST registration is per state.
 */
export interface Plant {
  code: string;
  name: string;
  address: Address;
  /** A plant in another state has its own registration. */
  gstin?: string;
  contact?: Contact;
  active: boolean;
}

export interface CompanyProfile {
  legalName: string;
  tradeName?: string;
  gstin?: string;
  pan?: string;
  /** Udyam registration number, for MSME customers. */
  msmeNumber?: string;
  registeredAddress?: Address;
  /** Omitted when billing is at the registered address. */
  billingAddress?: Address;
  contacts: Contact[];
  plants: Plant[];
}

export const EMPTY_PROFILE: CompanyProfile = {
  legalName: '',
  contacts: [],
  plants: [],
};

/* ------------------------------------------------------------- identifiers */

/**
 * GST state codes. The first two digits of a GSTIN, so they let us check that a
 * GSTIN agrees with the address it is attached to.
 */
export const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

/** `27ABCDE1234F1Z5` — state code, PAN, entity digit, Z, checksum. */
const GSTIN_PATTERN = /^([0-9]{2})([A-Z]{5}[0-9]{4}[A-Z])([1-9A-Z])(Z)([0-9A-Z])$/;
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
/** Udyam registration: `UDYAM-XX-00-0000000`. */
const UDYAM_PATTERN = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;

export interface IdentifierCheck {
  valid: boolean;
  /** Present when invalid, explaining what is wrong in plain terms. */
  problem?: string;
  /** Derived from a valid GSTIN. */
  stateCode?: string;
  stateName?: string;
  pan?: string;
}

/**
 * Validate a GSTIN structurally and read what it tells us.
 *
 * Structure only — this cannot confirm the number is registered, which needs the GST
 * portal. It does catch the common data-entry faults, and it extracts the embedded
 * PAN and state so they can be cross-checked against what was typed elsewhere.
 */
export function checkGstin(raw: string): IdentifierCheck {
  const value = raw.trim().toUpperCase();
  if (value === '') return { valid: false, problem: 'No GSTIN given.' };
  if (value.length !== 15) {
    return { valid: false, problem: `A GSTIN is 15 characters; this is ${value.length}.` };
  }

  const match = GSTIN_PATTERN.exec(value);
  if (!match) {
    return {
      valid: false,
      problem:
        'Not a valid GSTIN shape. Expected two digits, then a PAN, then one character, ' +
        'then Z, then one character — for example 27ABCDE1234F1Z5.',
    };
  }

  const [, stateCode, pan] = match as unknown as [string, string, string];
  const stateName = GST_STATE_CODES[stateCode];
  if (!stateName) {
    return { valid: false, problem: `${stateCode} is not a GST state code.`, stateCode };
  }

  return { valid: true, stateCode, stateName, pan };
}

export function checkPan(raw: string): IdentifierCheck {
  const value = raw.trim().toUpperCase();
  if (value === '') return { valid: false, problem: 'No PAN given.' };
  if (!PAN_PATTERN.test(value)) {
    return {
      valid: false,
      problem: 'A PAN is five letters, four digits, then a letter — for example ABCDE1234F.',
    };
  }
  return { valid: true, pan: value };
}

export function checkMsme(raw: string): IdentifierCheck {
  const value = raw.trim().toUpperCase();
  if (value === '') return { valid: false, problem: 'No Udyam number given.' };
  if (!UDYAM_PATTERN.test(value)) {
    return {
      valid: false,
      problem: 'Expected a Udyam number like UDYAM-MH-26-0123456.',
    };
  }
  return { valid: true };
}

/**
 * Cross-check the identifiers against each other.
 *
 * A GSTIN carries the PAN and the state inside it, so a mismatch against a
 * separately-typed PAN or a state in the address is a typo somewhere — and worth
 * catching before it reaches an invoice.
 */
export function crossCheckIdentifiers(input: {
  gstin?: string;
  pan?: string;
  stateName?: string;
}): string[] {
  const problems: string[] = [];
  if (!input.gstin) return problems;

  const gst = checkGstin(input.gstin);
  if (!gst.valid) {
    problems.push(gst.problem as string);
    return problems;
  }

  if (input.pan) {
    const pan = checkPan(input.pan);
    if (pan.valid && pan.pan !== gst.pan) {
      problems.push(
        `The GSTIN contains PAN ${gst.pan}, but the PAN field says ${pan.pan}. One of them is wrong.`,
      );
    }
  }

  if (input.stateName && gst.stateName) {
    const typed = input.stateName.trim().toLowerCase();
    if (typed !== '' && typed !== gst.stateName.toLowerCase()) {
      problems.push(
        `The GSTIN is registered in ${gst.stateName}, but the address says ${input.stateName}.`,
      );
    }
  }

  return problems;
}
