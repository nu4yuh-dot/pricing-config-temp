import type { Pincode } from './types';

/**
 * City, derived from the district the Bluedart import carries.
 *
 * The master's own `area` is a post office — 300 of them in Maharashtra alone — so it
 * cannot serve as a city. District is populated for every pincode on file (19,494 of
 * 19,494, 747 distinct) and is the closest thing to a city this data actually has.
 *
 * Two imprecisions, recorded rather than smoothed over. District merges towns that trade
 * as separate cities: Pimpri-Chinchwad pincodes carry district `Pune`. And a few districts
 * are named differently from the city everybody says, which the alias table fixes for the
 * ones that come up. Both are data concerns — the `city` endpoint matches on a string, so
 * splitting a district into its real cities later needs no change to the matcher.
 */

/** District name -> what the business calls it. Renames only; a no-op entry is noise. */
export const CITY_ALIASES: Record<string, string> = {
  'Bengaluru Urban': 'Bangalore',
  'Bengaluru Rural': 'Bangalore',
  'Mumbai Suburban': 'Mumbai',
  Gurgaon: 'Gurugram',
  'Gautam Buddha Nagar': 'Noida',
};

export function cityOf(pincode: Pincode): string | undefined {
  const district = pincode.bluedart?.district?.trim();
  if (!district) return undefined;
  return CITY_ALIASES[district] ?? district;
}

/** The same pincode with `city` filled in, for the matcher to read. */
export function withCity(pincode: Pincode): Pincode {
  const city = cityOf(pincode);
  return city === undefined ? pincode : { ...pincode, city };
}
