#!/usr/bin/env python3
"""
Build the UPS / MOVIN international card from the signed paperwork.

Two sources, and which one wins is a decision rather than a convenience:

  * `Approved Rates for DNS Express - Ex Mum - Revised (2).xlsx` is the **contract**. Its
    Zoning Guide and its rate grid are the truth — all 249 destination codes including the
    Zone 6/7 Specials, China's postal splits, and the Envelope and Document products.
  * `DNS_International_RateCard.xlsx` is a **calculator** built over that contract. It is
    the only source for things the contract does not state: the sell margin, the surge
    fees and their regions, and the fuel/GST parameters.

Where the two disagree the contract wins. The calculator's own zone guide is missing 39
destinations the contract prices, so taking it as authoritative would leave a shipment to
Trinidad or the Maldives unquotable.

    python3 scripts/extract_ups.py

Writes data/extracted/ups-data.json, which scripts/build-ups-card.ts wraps into a
rate card. Re-runnable; reads nothing but the two workbooks.
"""

from __future__ import annotations

import html
import json
import re
import sys
import zipfile
from pathlib import Path

DOWNLOADS = Path.home() / "Downloads"
CONTRACT = DOWNLOADS / "Approved Rates for DNS Express - Ex Mum - Revised (2).xlsx"
CALCULATOR = DOWNLOADS / "DNS_International_RateCard.xlsx"
OUT = Path(__file__).resolve().parent.parent / "data" / "extracted" / "ups-data.json"

# ---------------------------------------------------------------- xlsx reading


def read_sheet(path: Path, sheet: str) -> dict[int, dict[str, str]]:
    """Every non-empty cell of one sheet, as {row: {column: text}}."""
    z = zipfile.ZipFile(path)
    shared: list[str] = []
    try:
        raw = z.read("xl/sharedStrings.xml").decode("utf-8", "ignore")
        shared = [
            html.unescape("".join(re.findall(r"<t[^>]*>(.*?)</t>", si, re.S)))
            for si in re.findall(r"<si>(.*?)</si>", raw, re.S)
        ]
    except KeyError:
        pass

    data = z.read(sheet).decode("utf-8", "ignore")
    rows: dict[int, dict[str, str]] = {}
    for rnum, body in re.findall(r'<row[^>]*r="(\d+)"[^>]*>(.*?)</row>', data, re.S):
        cells: dict[str, str] = {}
        for m in re.finditer(r'<c r="([A-Z]+)\d+"([^>]*)(?:/>|>(.*?)</c>)', body, re.S):
            col, attrs, inner = m.group(1), m.group(2), m.group(3) or ""
            kind = re.search(r't="(\w+)"', attrs)
            value = re.search(r"<v>(.*?)</v>", inner, re.S)
            inline = re.findall(r"<is>.*?<t[^>]*>(.*?)</t>.*?</is>", inner, re.S)
            if inline:
                text = html.unescape(inline[0])
            elif value:
                text = html.unescape(value.group(1))
                if kind and kind.group(1) == "s":
                    text = shared[int(text)]
            else:
                continue
            if text != "":
                cells[col] = text
        if cells:
            rows[int(rnum)] = cells
    return rows


def number(text: str | None) -> float | None:
    if text is None or text == "":
        return None
    try:
        return float(text)
    except ValueError:
        return None


# ------------------------------------------------------------- zone key naming

# The contract writes a zone three ways — "8", "AU", "Zone 7 Specials - (NE/VI/...)" —
# and its rate grid heads the same columns differently again ("ZONE 8", "PL , CZ ,  RO ,
# HU"). One canonical key per zone, so the two sheets can be joined without guessing.
def zone_key(text: str) -> str | None:
    t = " ".join(text.split()).strip()
    if t in ("", "-"):
        return None
    if t.lower().startswith("zone 6 specials"):
        return "Z6SP"
    if t.lower().startswith("zone 7 specials"):
        return "Z7SP"
    m = re.fullmatch(r"(?:ZONE\s*)?([1-9])", t, re.I)
    if m:
        return f"Z{m.group(1)}"
    # "PL , CZ ,  RO , HU" and "PLHUROCZ" are the same column.
    letters = re.sub(r"[^A-Z]", "", t.upper())
    if letters in ("PLCZROHU", "PLHUROCZ", "PLHURO"):
        return "PLHUROCZ"
    if letters in ("US", "CA", "AU", "NZ", "SG", "DE"):
        return letters
    return None


CHINA_RANGE = re.compile(r"postal codes\s*(\d+)\s*-\s*(\d+)", re.I)


# -------------------------------------------------------------------- contract


def read_contract() -> dict:
    zoning = read_sheet(CONTRACT, "xl/worksheets/sheet1.xml")
    rates_sheet = read_sheet(CONTRACT, "xl/worksheets/sheet2.xml")

    zones: dict[str, str] = {}
    postal_zones: list[dict] = []
    unserved: list[str] = []
    names: dict[str, str] = {}

    for rnum in sorted(zoning):
        if rnum < 6:
            continue
        row = zoning[rnum]
        name, code, raw = row.get("A", ""), row.get("B", ""), row.get("C", "")
        if not code:
            continue
        key = zone_key(raw)
        if key is None:
            unserved.append(code)
            names.setdefault(code, name)
            continue

        span = CHINA_RANGE.search(name)
        if span:
            postal_zones.append(
                {
                    "country": code,
                    "from": int(span.group(1)),
                    "to": int(span.group(2)),
                    "zone": key,
                }
            )
            names.setdefault(code, name.split("(")[0].strip())
            continue

        # A code listed twice without a postal split (VG, SX) keeps the first zone. Both
        # pairs agree in this card, so nothing is lost — but a later disagreement should
        # be seen rather than silently resolved.
        if code in zones and zones[code] != key:
            print(f"  ! {code} appears twice with different zones: {zones[code]} and {key}")
        zones.setdefault(code, key)
        names.setdefault(code, name)

    # The rate grid: column headings on row 13, blocks below.
    heading = rates_sheet.get(13, {})
    columns: dict[str, str] = {}
    for col, text in heading.items():
        key = zone_key(text)
        if key:
            columns[col] = key

    def rates_at(rnum: int) -> dict[str, float]:
        row = rates_sheet.get(rnum, {})
        out: dict[str, float] = {}
        for col, key in columns.items():
            value = number(row.get(col))
            if value is not None:
                out[key] = value
        return out

    def weight_rows(first: int, last: int) -> list[dict]:
        out = []
        for rnum in range(first, last + 1):
            label = rates_sheet.get(rnum, {}).get("B", "")
            kg = number(label)
            if kg is None:
                continue
            out.append({"toKg": kg, "rates": rates_at(rnum)})
        return out

    def bulk_rows(first: int, last: int) -> list[dict]:
        out = []
        for rnum in range(first, last + 1):
            label = rates_sheet.get(rnum, {}).get("B", "")
            m = re.match(r"(\d+)", label)
            if not m:
                continue
            out.append({"fromKg": float(m.group(1)), "label": label, "rates": rates_at(rnum)})
        return out

    return {
        "zoneKeys": sorted(set(columns.values())),
        "zones": zones,
        "postalZones": postal_zones,
        "unserved": unserved,
        "destinationNames": names,
        "rates": {
            "envelope": rates_at(14),
            "document": weight_rows(16, 25),
            "package": weight_rows(28, 67),
            "bulk": bulk_rows(68, 74),
        },
    }


# ------------------------------------------------------------------ calculator


def read_calculator() -> dict:
    params_rows = read_sheet(CALCULATOR, "xl/worksheets/sheet2.xml")
    surge_rows = read_sheet(CALCULATOR, "xl/worksheets/sheet3.xml")
    guide_rows = read_sheet(CALCULATOR, "xl/worksheets/sheet4.xml")

    params: dict[str, float | str] = {}
    for row in params_rows.values():
        name, value = row.get("A", ""), row.get("B", "")
        num = number(value)
        params[name] = value if num is None else num

    surge: dict[str, float] = {}
    for rnum in sorted(surge_rows):
        if rnum == 1:
            continue
        row = surge_rows[rnum]
        region, gross = row.get("A", ""), number(row.get("B"))
        if region and gross is not None:
            surge[region] = gross

    regions: dict[str, str] = {}
    for rnum in sorted(guide_rows):
        row = guide_rows[rnum]
        code, region = row.get("A", ""), row.get("D", "")
        if code and code != "Country Code" and region:
            regions[code] = region

    return {"params": params, "surge": surge, "surgeRegions": regions}


# ------------------------------------------------------------------ accessorials

# Read from the calculator, which is the only place they carry a waiver percentage and a
# per-kg rate side by side. The contract's own accessorial PDF lists the same charges but
# not the waivers this customer negotiated.
def read_accessorials() -> list[dict]:
    rows = read_sheet(CALCULATOR, "xl/worksheets/sheet1.xml")
    out: list[dict] = []
    for rnum in sorted(rows):
        if rnum < 25 or rnum > 61:
            continue
        row = rows[rnum]
        name = row.get("B", "")
        if not name:
            continue
        out.append(
            {
                "id": re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:48],
                "name": name,
                "unit": row.get("C", ""),
                "minimum": number(row.get("D")) or 0.0,
                "perKg": number(row.get("E")) or 0.0,
                # 1 means fully waived for this customer, 0.5 half, 0 not waived.
                "waiver": number(row.get("G")) or 0.0,
                # Every one defaults to off in the workbook: an accessorial is something
                # a shipment attracts, not something a rate card applies by itself.
                "appliesByDefault": (row.get("H", "N").strip().upper() == "Y"),
            }
        )
    return out


def main() -> int:
    for path in (CONTRACT, CALCULATOR):
        if not path.exists():
            print(f"missing source workbook: {path}")
            return 1

    print(f"reading contract:   {CONTRACT.name}")
    contract = read_contract()
    print(f"reading calculator: {CALCULATOR.name}")
    calc = read_calculator()
    accessorials = read_accessorials()

    params = calc["params"]
    card = {
        "generatedFrom": [CONTRACT.name, CALCULATOR.name],
        "note": (
            "Zones, destinations and rates come from the approved contract; margin, fuel, "
            "surge and GST from the calculator built over it. Regenerate with "
            "scripts/extract_ups.py rather than editing by hand."
        ),
        "params": {
            "origin": params.get("Origin", "Mumbai (Ex-BOM)"),
            "margin": params.get("Margin on basic freight", 0.15),
            "fuelRate": params.get("Fuel surcharge %", 0.4675),
            "surgeDiscount": params.get("Surge discount %", 0.45),
            "gstRate": params.get("GST %", 0.18),
            "volumetricDivisor": params.get("Volumetric divisor", 5000),
            # From the calculator's chargeable-weight formula, MAX(actual, volumetric, 0.5).
            "minChargeableWeight": 0.5,
        },
        "zoneKeys": contract["zoneKeys"],
        "zones": contract["zones"],
        "postalZones": contract["postalZones"],
        "unserved": contract["unserved"],
        "destinationNames": contract["destinationNames"],
        "surge": calc["surge"],
        "surgeRegions": calc["surgeRegions"],
        # 189 of the calculator's 210 countries sit here, and the 39 the calculator omits
        # have no region at all, so this is what they fall back to.
        "defaultSurgeRegion": "Rest of the World",
        "rates": contract["rates"],
        "accessorials": accessorials,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(card, indent=2, sort_keys=False) + "\n")

    r = card["rates"]
    print(f"\nwrote {OUT}")
    print(f"  zone columns      {len(card['zoneKeys'])}  {card['zoneKeys']}")
    print(f"  destinations      {len(card['zones'])} coded, {len(card['postalZones'])} postal ranges, "
          f"{len(card['unserved'])} unserved {card['unserved']}")
    print(f"  envelope          {len(r['envelope'])} zones")
    print(f"  document rows     {len(r['document'])}  {r['document'][0]['toKg']}–{r['document'][-1]['toKg']} kg")
    print(f"  package rows      {len(r['package'])}  {r['package'][0]['toKg']}–{r['package'][-1]['toKg']} kg")
    print(f"  bulk bands        {len(r['bulk'])}  {[b['label'] for b in r['bulk']]}")
    print(f"  surge regions     {len(card['surge'])}  {card['surge']}")
    print(f"  accessorials      {len(card['accessorials'])}")

    missing = sorted(set(card["zones"]) - set(card["surgeRegions"]))
    print(f"  no surge region   {len(missing)} -> default '{card['defaultSurgeRegion']}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
