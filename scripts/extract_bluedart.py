#!/usr/bin/env python3
"""
Merge the Bluedart franchise resolution into the pincode master.

The franchise workbook carries the same 19,494 pincodes as the DNS workbooks, with the
same area names and states, but resolves each one differently: five directional zones
ex-Pune, an ODA tier, and an EDL distance. That is a second resolution of one pincode,
not a second pincode master, so it is merged into the existing record rather than stored
apart -- one pincode, one document, one place to look.

Also corrects three area names. The DNS source workbook contains 'air partnerpet',
'I.E.air partnerpet' and 'air partnernagar SO Bardhaman', which are Suryapet, I.E.Suryapet
and Suryanagar SO Bardhaman with 'Surya' replaced by 'air partner' -- a find-and-replace
that caught three post-office names. The franchise workbook has them intact, so it is used
as the second source. Display only; no price depends on an area name.

Usage: python3 scripts/extract_bluedart.py [--workbook-dir DIR]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import openpyxl

REPO = Path(__file__).resolve().parent.parent
PINCODES = REPO / "data" / "extracted" / "pincodes.json"
WORKBOOK = "DNS_Directional_RateCard_Calculator.xlsx"

ZONES = {"WEST", "NORTH", "SOUTH", "EAST", "NE & REMOTE"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workbook-dir", default=str(Path.home() / "Downloads"))
    args = parser.parse_args()

    src = Path(args.workbook_dir) / WORKBOOK
    if not src.exists():
        print(f"missing workbook: {src}", file=sys.stderr)
        return 1

    print("reading the franchise pincode master...")
    wb = openpyxl.load_workbook(src, read_only=True, data_only=False)
    franchise: dict[int, tuple] = {}
    for row in wb["Pincode Master"].iter_rows(min_row=2, values_only=True):
        pin, area, district, state, zone, status, km = row[:7]
        if pin is None:
            continue
        if zone not in ZONES:
            print(f"  refusing: pincode {pin} has zone {zone!r}, which is not on the card",
                  file=sys.stderr)
            return 1
        franchise[pin] = (area, district, state, zone, status, km or 0)
    wb.close()
    print(f"  {len(franchise)} pincodes")

    existing = json.loads(PINCODES.read_text())
    print(f"existing master: {len(existing)} pincodes")

    missing = [p["pincode"] for p in existing if p["pincode"] not in franchise]
    extra = sorted(set(franchise) - {p["pincode"] for p in existing})
    if missing or extra:
        print(f"  refusing: {len(missing)} not in the franchise card, {len(extra)} not in the "
              f"existing master. The two must cover the same pincodes.", file=sys.stderr)
        return 1

    renamed = 0
    for record in existing:
        area, district, state, zone, status, km = franchise[record["pincode"]]

        # The franchise workbook is a second, uncorrupted source for the area name.
        if area and area != record["area"]:
            print(f"  area corrected: {record['pincode']} {record['area']!r} -> {area!r}")
            record["area"] = area
            renamed += 1

        record["bluedart"] = {
            "zone": zone,
            "odaStatus": status,
            "edlKm": km,
            "district": district,
        }
        # A state disagreement would change the zone, so it is reported rather than merged.
        if state != record["state"]:
            print(f"  STATE DISAGREEMENT: {record['pincode']} existing {record['state']!r} vs "
                  f"franchise {state!r} -- left as it was", file=sys.stderr)

    PINCODES.write_text(json.dumps(existing) + "\n")
    print(f"wrote {PINCODES}")
    print(f"  {renamed} area name(s) corrected, {len(existing)} pincodes carry a Bluedart zone")
    return 0


if __name__ == "__main__":
    sys.exit(main())
