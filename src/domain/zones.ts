/**
 * Zone codes, transcribed from the source workbooks' `Cluster Guide` sheet.
 *
 * The source sheet is titled "SURFACE CLUSTERS (20)" but lists 21 codes; the
 * count is derived here rather than restated, so it cannot drift again.
 */

export const SURFACE_ZONES = [
  'PNQ', 'PCMC', 'KSK', 'CSN', 'BOM', 'NAG', 'AMD', 'IDR', 'NCR', 'BWR', 'UTR',
  'LDH', 'UPX', 'BLR', 'HSR', 'MAA', 'CJB', 'HYD', 'CCU', 'JSR', 'GAU',
] as const;

export const AIR_ZONES = [
  'PNQ', 'BOM', 'AMD', 'IDR', 'NCR', 'UTR', 'BLR', 'MAA', 'HYD', 'CJB', 'CCU', 'NAG',
] as const;

export type SurfaceZone = (typeof SURFACE_ZONES)[number];
export type AirZone = (typeof AIR_ZONES)[number];
export type ZoneCode = SurfaceZone | AirZone;

/** Rail runs over the surface cluster network (railhead to railhead). */
export const RAIL_ZONES = SURFACE_ZONES;

export const SURFACE_ZONE_NAMES: Record<SurfaceZone, string> = {
  PNQ: 'Pune City (PMC) & Pune rural',
  PCMC: 'PCMC — Pimpri-Chinchwad-Bhosari-Nigdi-Talawade-Hinjewadi-Talegaon-Chakan',
  KSK: 'Kolhapur–Sangli–Satara',
  CSN: 'Aurangabad–Nashik–Ahmednagar',
  BOM: 'Mumbai–Thane–Bhiwandi',
  NAG: 'Nagpur–Vidarbha–Raipur',
  AMD: 'Ahmedabad–Sanand–Vadodara–Rajkot',
  IDR: 'Indore–Pithampur–Bhopal',
  NCR: 'Delhi–Gurugram–Manesar–Faridabad–Noida',
  BWR: 'Bhiwadi–Neemrana–Alwar–Jaipur',
  UTR: 'Rudrapur–Pantnagar–Haridwar–Baddi',
  LDH: 'Ludhiana–Mohali–Chandigarh',
  UPX: 'Kanpur–Lucknow (rest UP)',
  BLR: 'Bengaluru–Bidadi',
  HSR: 'Hosur–Krishnagiri',
  MAA: 'Chennai–Sriperumbudur–Oragadam',
  CJB: 'Coimbatore–Tirupur–Kerala',
  HYD: 'Hyderabad–Vijayawada–Vizag',
  CCU: 'Kolkata–Odisha–Bihar',
  JSR: 'Jamshedpur–Ranchi–Bokaro',
  GAU: 'Guwahati / NE',
};

export const AIR_ZONE_NAMES: Record<AirZone, string> = {
  PNQ: 'Pune',
  BOM: 'Mumbai',
  AMD: 'Ahmedabad',
  IDR: 'Indore',
  NCR: 'Delhi-NCR',
  UTR: 'Uttarakhand',
  BLR: 'Bengaluru',
  MAA: 'Chennai',
  HYD: 'Hyderabad',
  CJB: 'Coimbatore',
  CCU: 'Kolkata',
  NAG: 'Nagpur',
};

/** Zones a given mode is quoted over. */
export function zonesForMode(mode: 'air' | 'nfo' | 'surface' | 'rail'): readonly string[] {
  return mode === 'air' || mode === 'nfo' ? AIR_ZONES : SURFACE_ZONES;
}
