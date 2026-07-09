#!/usr/bin/env python3
"""Nationwide BatchData payload validation harness.

This script intentionally keeps API keys out of files. Provide the key with
BATCHDATA_API_KEY or BATCH_DATA_API_KEY in the process environment.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


BATCHDATA_URL = "https://api.batchdata.com/api/v1/property/search"
BATCHDATA_MAX_TAKE = 500

PROPERTY_TYPE_ALIASES = (
    "single family",
    "single family residential",
    "single-family",
    "sfr",
    "sfh",
    "detached",
    "one family",
    "1 family",
)
NOISE_KEYWORDS = (
    "commercial",
    "industrial",
    "retail",
    "office",
    "warehouse",
    "business",
    "shopping",
    "hotel",
    "motel",
    "restaurant",
    "medical",
    "hospital",
    "condo",
    "condominium",
    "apartment",
    "co op",
    "coop",
    "cooperative",
    "multifamily",
    "multi family",
    "multi-family",
    "duplex",
    "triplex",
    "fourplex",
    "townhouse",
    "townhome",
    "row house",
    "rowhouse",
    "land",
    "lot",
    "vacant",
    "acreage",
    "farm",
    "agricultural",
)


def now_slug() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%SZ")


def bbox_polygon(north: float, east: float, south: float, west: float) -> list[dict[str, float]]:
    return [
        {"lat": north, "lng": west},
        {"lat": north, "lng": east},
        {"lat": south, "lng": east},
        {"lat": south, "lng": west},
        {"lat": north, "lng": west},
    ]


MARKETS: list[dict[str, Any]] = [
    {"market": "Austin TX", "city": "Austin", "state": "TX", "region": "Sun Belt", "type": "urban", "polygon": bbox_polygon(30.50, -97.55, 30.05, -97.95)},
    {"market": "Phoenix AZ", "city": "Phoenix", "state": "AZ", "region": "Sun Belt", "type": "urban", "polygon": bbox_polygon(33.75, -111.80, 33.25, -112.35)},
    {"market": "Tampa FL", "city": "Tampa", "state": "FL", "region": "Sun Belt", "type": "urban", "polygon": bbox_polygon(28.10, -82.25, 27.80, -82.65)},
    {"market": "Charlotte NC", "city": "Charlotte", "state": "NC", "region": "Sun Belt", "type": "urban", "polygon": bbox_polygon(35.40, -80.60, 35.05, -81.05)},
    {"market": "Atlanta GA", "city": "Atlanta", "state": "GA", "region": "Sun Belt", "type": "urban", "polygon": bbox_polygon(34.05, -84.10, 33.55, -84.65)},
    {"market": "Indianapolis IN", "city": "Indianapolis", "state": "IN", "region": "Midwest", "type": "urban", "polygon": bbox_polygon(39.95, -85.95, 39.60, -86.35)},
    {"market": "Columbus OH", "city": "Columbus", "state": "OH", "region": "Midwest", "type": "urban", "polygon": bbox_polygon(40.15, -82.80, 39.80, -83.20)},
    {"market": "Kansas City MO", "city": "Kansas City", "state": "MO", "region": "Midwest", "type": "urban", "polygon": bbox_polygon(39.25, -94.35, 38.85, -94.80)},
    {"market": "Milwaukee WI", "city": "Milwaukee", "state": "WI", "region": "Midwest", "type": "urban", "polygon": bbox_polygon(43.20, -87.80, 42.85, -88.10)},
    {"market": "Detroit MI", "city": "Detroit", "state": "MI", "region": "Midwest", "type": "urban", "polygon": bbox_polygon(42.55, -82.90, 42.20, -83.35)},
    {"market": "Philadelphia PA", "city": "Philadelphia", "state": "PA", "region": "Northeast", "type": "urban", "polygon": bbox_polygon(40.15, -74.95, 39.80, -75.35)},
    {"market": "Hartford CT", "city": "Hartford", "state": "CT", "region": "Northeast", "type": "suburban", "polygon": bbox_polygon(41.90, -72.55, 41.65, -72.85)},
    {"market": "Providence RI", "city": "Providence", "state": "RI", "region": "Northeast", "type": "suburban", "polygon": bbox_polygon(41.90, -71.30, 41.70, -71.55)},
    {"market": "Pittsburgh PA", "city": "Pittsburgh", "state": "PA", "region": "Northeast", "type": "urban", "polygon": bbox_polygon(40.55, -79.80, 40.30, -80.15)},
    {"market": "Richmond VA", "city": "Richmond", "state": "VA", "region": "Northeast", "type": "urban", "polygon": bbox_polygon(37.65, -77.30, 37.40, -77.60)},
    {"market": "Houston TX", "city": "Houston", "state": "TX", "region": "South", "type": "urban", "polygon": bbox_polygon(30.05, -95.00, 29.50, -95.80)},
    {"market": "Nashville TN", "city": "Nashville", "state": "TN", "region": "South", "type": "urban", "polygon": bbox_polygon(36.30, -86.55, 36.00, -87.00)},
    {"market": "Raleigh NC", "city": "Raleigh", "state": "NC", "region": "South", "type": "urban", "polygon": bbox_polygon(35.95, -78.45, 35.65, -78.85)},
    {"market": "New Orleans LA", "city": "New Orleans", "state": "LA", "region": "South", "type": "urban", "polygon": bbox_polygon(30.10, -89.85, 29.85, -90.20)},
    {"market": "Anderson SC", "city": "Anderson", "state": "SC", "region": "South", "type": "known_market", "polygon": bbox_polygon(34.769, -82.374, 34.256, -82.878)},
    {"market": "Denver CO", "city": "Denver", "state": "CO", "region": "West", "type": "urban", "polygon": bbox_polygon(39.90, -104.70, 39.55, -105.15)},
    {"market": "Las Vegas NV", "city": "Las Vegas", "state": "NV", "region": "West", "type": "urban", "polygon": bbox_polygon(36.35, -114.95, 36.00, -115.35)},
    {"market": "Salt Lake City UT", "city": "Salt Lake City", "state": "UT", "region": "West", "type": "urban", "polygon": bbox_polygon(40.90, -111.75, 40.60, -112.10)},
    {"market": "Portland OR", "city": "Portland", "state": "OR", "region": "West", "type": "urban", "polygon": bbox_polygon(45.65, -122.45, 45.40, -122.85)},
    {"market": "Albuquerque NM", "city": "Albuquerque", "state": "NM", "region": "West", "type": "urban", "polygon": bbox_polygon(35.25, -106.45, 35.00, -106.80)},
]


class BudgetExceeded(RuntimeError):
    pass


@dataclass
class ApiResult:
    label: str
    payload: dict[str, Any]
    response: dict[str, Any] | None
    records: list[dict[str, Any]]
    total: int | None
    returned: int
    estimated_credits: int
    elapsed_ms: int
    error: str | None = None


class BatchDataClient:
    def __init__(self, api_key: str, budget: int, sleep_s: float = 0.15, timeout_s: int = 30):
        self.api_key = api_key
        self.budget = budget
        self.sleep_s = sleep_s
        self.timeout_s = timeout_s
        self.estimated_credits = 0
        self.calls = 0
        self.errors = 0

    def remaining_budget(self) -> int:
        return max(0, self.budget - self.estimated_credits)

    def call(self, label: str, payload: dict[str, Any]) -> ApiResult:
        take = int(payload.get("options", {}).get("take", 25) or 0)
        if take == 0 and self.remaining_budget() < 1:
            raise BudgetExceeded("No budget remaining for count request.")
        if take > 0 and self.remaining_budget() <= 0:
            raise BudgetExceeded("No budget remaining for data request.")

        started = time.time()
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            BATCHDATA_URL,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
        )

        last_error = None
        for attempt in range(1, 5):
            try:
                with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
                    text = response.read().decode("utf-8", errors="replace")
                    parsed = json.loads(text) if text else {}
                    records = extract_records(parsed)
                    charge = 1 if take == 0 else len(records)
                    self.estimated_credits += charge
                    self.calls += 1
                    elapsed_ms = int((time.time() - started) * 1000)
                    if self.sleep_s:
                        time.sleep(self.sleep_s)
                    return ApiResult(
                        label=label,
                        payload=payload,
                        response=parsed,
                        records=records,
                        total=extract_total(parsed),
                        returned=len(records),
                        estimated_credits=charge,
                        elapsed_ms=elapsed_ms,
                    )
            except urllib.error.HTTPError as exc:
                text = exc.read().decode("utf-8", errors="replace")
                last_error = f"HTTP {exc.code}: {text[:1000]}"
                if exc.code in (429, 500, 503) and attempt < 4:
                    time.sleep(2 ** attempt)
                    continue
                break
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)
                if attempt < 4:
                    time.sleep(2 ** attempt)
                    continue
                break

        self.errors += 1
        elapsed_ms = int((time.time() - started) * 1000)
        return ApiResult(
            label=label,
            payload=payload,
            response=None,
            records=[],
            total=None,
            returned=0,
            estimated_credits=0,
            elapsed_ms=elapsed_ms,
            error=last_error or "Unknown request failure.",
        )


def sold_window_days(sold_months: float) -> int:
    if abs(sold_months - (1 / 30)) < 0.0001:
        return 1
    if abs(sold_months - (2 / 30)) < 0.0001:
        return 2
    if sold_months == 0.25:
        return 7
    if sold_months == 0.5:
        return 14
    if sold_months == 1:
        return 30
    if sold_months == 3:
        return 90
    if sold_months == 6:
        return 180
    if sold_months == 9:
        return 270
    if sold_months == 12:
        return 365
    return max(1, round(float(sold_months) * 30))


def iso_days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()


def normalize_text(value: Any) -> str:
    return " ".join(str(value or "").lower().replace("/", " ").replace("_", " ").replace("-", " ").split())


def is_explicit_sfr(value: Any) -> bool:
    text = normalize_text(value)
    return bool(text) and any(alias in text for alias in PROPERTY_TYPE_ALIASES)


def has_noise_keyword(*values: Any) -> bool:
    text = normalize_text(" ".join(str(value or "") for value in values))
    return any(keyword in text for keyword in NOISE_KEYWORDS)


def has_address_unit_marker(value: Any) -> bool:
    text = str(value or "")
    import re
    return bool(re.search(r"(?:^|[\s,])(?:apt|apartment|unit|ste|suite|#)\s*[a-z0-9-]+(?:$|[\s,])", text, re.I))


def property_obj(record: dict[str, Any]) -> dict[str, Any]:
    nested = record.get("property")
    return nested if isinstance(nested, dict) else record


def first_value(*values: Any) -> Any:
    for value in values:
        if value not in (None, ""):
            return value
    return None


def latest_date_value(*values: Any) -> str | None:
    latest: str | None = None
    latest_dt: datetime | None = None
    for value in values:
        parsed = parse_date(value)
        if not parsed:
            continue
        try:
            parsed_dt = datetime.fromisoformat(parsed)
        except ValueError:
            continue
        if latest_dt is None or parsed_dt > latest_dt:
            latest_dt = parsed_dt
            latest = parsed
    return latest


def type_fields(record: dict[str, Any]) -> dict[str, str]:
    p = property_obj(record)
    general = p.get("general") or p.get("property") or p.get("propertyInfo") or {}
    building = p.get("building") or p.get("structure") or p.get("propertyInfo") or {}
    address = p.get("address") or {}
    street = str(first_value(address.get("street"), p.get("formattedAddress"), p.get("addressLine1"), "") or "")
    quick_lists = p.get("quickLists") or {}
    address_has_unit = has_address_unit_marker(street)
    inferred_disallowed = "Vacant Land" if quick_lists.get("vacantLot") else "Condo/Multi-Family" if address_has_unit else None
    land_use = first_value(
        general.get("standardizedLandUseCode"),
        p.get("standardizedLandUseCode"),
        general.get("landUseCode"),
        p.get("landUseCode"),
    )
    property_type = first_value(
        general.get("propertyTypeDetail"),
        general.get("propertyType"),
        p.get("propertyType"),
        p.get("landUse"),
        building.get("propertyType"),
        inferred_disallowed,
    )
    return {
        "land_use": str(land_use or "missing"),
        "property_type": str(property_type or "missing"),
        "combined": f"{land_use or 'missing'} | {property_type or 'missing'}",
    }


def intel_last_sold_date(record: dict[str, Any]) -> str | None:
    value = (property_obj(record).get("intel") or {}).get("lastSoldDate")
    return parse_date(value)


def parse_date(value: Any) -> str | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return str(value)[:10] if len(str(value)) >= 10 else None


def first_recording_date(items: Any, *field_names: str) -> Any:
    if not isinstance(items, list):
        return None
    for item in items:
        if not isinstance(item, dict):
            continue
        for field_name in field_names:
            if item.get(field_name):
                return item.get(field_name)
    return None


def provider_sale_date(record: dict[str, Any]) -> str | None:
    p = property_obj(record)
    sale = p.get("sale") or p.get("lastSale") or ((p.get("deed") or {}).get("sale")) or p.get("transaction") or {}
    last_sale = sale.get("lastSale") or sale.get("lastTransfer") or sale
    latest_sale_mortgage = first_recording_date(last_sale.get("mortgages"), "recordingDate", "saleDate")
    latest_history_date = first_recording_date(p.get("mortgageHistory"), "saleDate", "recordingDate")
    return latest_date_value(
        (p.get("intel") or {}).get("lastSoldDate"),
        (p.get("intel") or {}).get("lastSaleDate"),
        (p.get("intel") or {}).get("lastTransferDate"),
        (p.get("listing") or {}).get("soldDate"),
        first_recording_date(p.get("deedHistory"), "saleDate", "recordingDate"),
        sale.get("lastSaleDate"),
        sale.get("recordingDate"),
        sale.get("saleDate"),
        sale.get("date"),
        last_sale.get("recordingDate") if isinstance(last_sale, dict) else None,
        last_sale.get("saleDate") if isinstance(last_sale, dict) else None,
        last_sale.get("date") if isinstance(last_sale, dict) else None,
        latest_sale_mortgage,
        (p.get("openLien") or {}).get("firstLoanRecordingDate"),
        (p.get("openLien") or {}).get("lastLoanRecordingDate"),
        latest_history_date,
        p.get("lastSaleDate"),
    )


def extract_records(payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not payload:
        return []
    batch = (((payload.get("results") or {}).get("properties")) or payload.get("properties") or payload.get("results") or [])
    if isinstance(batch, list):
        return [record for record in batch if isinstance(record, dict)]
    return [batch] if isinstance(batch, dict) else []


def extract_total(payload: dict[str, Any] | None) -> int | None:
    if not payload:
        return None
    candidates = [
        (payload.get("results") or {}).get("totalRecordCount") if isinstance(payload.get("results"), dict) else None,
        payload.get("totalRecordCount"),
        (payload.get("meta") or {}).get("totalRecordCount") if isinstance(payload.get("meta"), dict) else None,
    ]
    for value in candidates:
        if value is None:
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return None


def frequency_table(records: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    counts = Counter(type_fields(record)[key] for record in records)
    total = len(records)
    return [
        {"value": value, "count": count, "pct": round((count / total) * 100, 1) if total else 0}
        for value, count in counts.most_common()
    ]


def date_distribution(records: list[dict[str, Any]], min_date: str | None) -> dict[str, Any]:
    dates: list[str] = []
    intel_present = 0
    intel_absent = 0
    provider_present = 0
    provider_absent = 0
    in_window = 0
    outside_window = 0
    for record in records:
        intel_date = intel_last_sold_date(record)
        sale_date = provider_sale_date(record)
        date = intel_date or sale_date
        if intel_date:
            intel_present += 1
        else:
            intel_absent += 1
        if sale_date:
            provider_present += 1
        else:
            provider_absent += 1
        if not date:
            continue
        dates.append(date)
        if min_date and date < min_date:
            outside_window += 1
        else:
            in_window += 1
    dates.sort()
    return {
        "intel_lastSoldDate_present": intel_present,
        "intel_lastSoldDate_absent": intel_absent,
        "intel_lastSoldDate_present_pct": round((intel_present / len(records)) * 100, 1) if records else 0,
        "provider_sale_date_present": provider_present,
        "provider_sale_date_absent": provider_absent,
        "provider_sale_date_present_pct": round((provider_present / len(records)) * 100, 1) if records else 0,
        "in_window": in_window,
        "outside_window": outside_window,
        "earliest": dates[0] if dates else None,
        "newest": dates[-1] if dates else None,
        "silent_ignore_indicator": "WARNING" if outside_window else "none detected",
        "date_source_note": (
            "intel.lastSoldDate present"
            if intel_present
            else "intel.lastSoldDate absent; using sale/open-lien recording fields"
            if provider_present
            else "no sale date field present"
        ),
    }


def raw_sample(record: dict[str, Any]) -> dict[str, Any]:
    p = property_obj(record)
    general = p.get("general") or {}
    sale = p.get("sale") or {}
    return {
        "address": first_value(p.get("formattedAddress"), (p.get("address") or {}).get("street"), p.get("addressLine1")),
        "field_paths": {
            "property.general.standardizedLandUseCode": general.get("standardizedLandUseCode"),
            "property.general.propertyTypeDetail": general.get("propertyTypeDetail"),
            "property.general.propertyType": general.get("propertyType"),
            "property.propertyType": p.get("propertyType"),
            "property.landUse": p.get("landUse"),
            "property.intel.lastSoldDate": (p.get("intel") or {}).get("lastSoldDate"),
            "property.intel.lastSoldPrice": (p.get("intel") or {}).get("lastSoldPrice"),
            "property.quickLists.recentlySold": (p.get("quickLists") or {}).get("recentlySold"),
            "property.quickLists.vacantLot": (p.get("quickLists") or {}).get("vacantLot"),
            "property.openLien.firstLoanRecordingDate": (p.get("openLien") or {}).get("firstLoanRecordingDate"),
            "property.openLien.lastLoanRecordingDate": (p.get("openLien") or {}).get("lastLoanRecordingDate"),
            "property.sale.lastSaleDate": first_value(sale.get("lastSaleDate"), sale.get("saleDate"), p.get("lastSaleDate")),
            "property.sale.lastSale.mortgages[0].recordingDate": first_recording_date(((sale.get("lastSale") or {}) if isinstance(sale.get("lastSale"), dict) else {}).get("mortgages"), "recordingDate", "saleDate"),
            "property.mortgageHistory[0].saleDate": first_recording_date(p.get("mortgageHistory"), "saleDate"),
            "property.mortgageHistory[0].recordingDate": first_recording_date(p.get("mortgageHistory"), "recordingDate"),
        },
        "full_raw_payload": record,
    }


def format_polygon(polygon: list[dict[str, Any]], coord_format: str) -> list[dict[str, float]]:
    points = []
    for point in polygon:
        lat = float(point.get("lat", point.get("latitude")))
        lng = float(point.get("lng", point.get("longitude")))
        points.append({"lat": lat, "lng": lng} if coord_format == "lat_lng" else {"latitude": lat, "longitude": lng})
    if points and points[0] != points[-1]:
        points.append(dict(points[0]))
    return points


def build_payload(
    *,
    market: dict[str, Any] | None = None,
    city: str | None = None,
    state: str | None = None,
    polygon: list[dict[str, Any]] | None = None,
    sold_min_date: str | None = None,
    take: int = 25,
    skip: int = 0,
    include_r2: bool = False,
    coord_format: str = "latitude_longitude",
) -> dict[str, Any]:
    city = city or (market or {}).get("city")
    state = state or (market or {}).get("state")
    polygon = polygon or (market or {}).get("polygon")
    search: dict[str, Any] = {}
    if polygon:
        search["address"] = {"geoLocationPolygon": {"geoPoints": format_polygon(polygon, coord_format)}}
    else:
        search["address"] = {"city": {"equals": city}, "state": {"equals": state}}
    if sold_min_date:
        search["intel"] = {"lastSoldDate": {"minDate": sold_min_date}}
    if include_r2:
        search["general"] = {"standardizedLandUseCode": {"equals": "R2"}}
    return {"searchCriteria": search, "options": {"take": max(0, min(int(take), BATCHDATA_MAX_TAKE)), "skip": max(0, int(skip))}}


def result_summary(api_result: ApiResult, min_date: str | None = None, include_samples: int = 3) -> dict[str, Any]:
    return {
        "label": api_result.label,
        "error": api_result.error,
        "returned": api_result.returned,
        "total": api_result.total,
        "estimated_credits": api_result.estimated_credits,
        "elapsed_ms": api_result.elapsed_ms,
        "date_distribution": date_distribution(api_result.records, min_date),
        "land_use_frequency": frequency_table(api_result.records, "land_use"),
        "property_type_frequency": frequency_table(api_result.records, "property_type"),
        "combined_frequency": frequency_table(api_result.records, "combined"),
        "raw_samples": [raw_sample(record) for record in api_result.records[:include_samples]],
    }


def count_for_decision(summary: dict[str, Any]) -> int:
    total = summary.get("total")
    if isinstance(total, int):
        return total
    return int(summary.get("returned") or 0)


def run_raw_discovery(client: BatchDataClient, market: dict[str, Any], sold_months: float, take: int) -> dict[str, Any]:
    min_date = iso_days_ago(sold_window_days(sold_months))
    count_result = client.call(
        f"{market['market']} raw city/state count",
        build_payload(market=market, polygon=None, sold_min_date=None, take=0),
    )
    probe_result = client.call(
        f"{market['market']} raw city/state sold probe",
        build_payload(market=market, polygon=None, sold_min_date=min_date, take=take),
    )
    return {
        "sold_min_date": min_date,
        "count_no_date": result_summary(count_result, None, 0),
        "probe_with_date": result_summary(probe_result, min_date, 5),
    }


def run_market_health(client: BatchDataClient, market: dict[str, Any]) -> dict[str, Any]:
    min_date = iso_days_ago(90)
    total_result = client.call(
        f"{market['market']} health total count",
        build_payload(market=market, polygon=None, take=0),
    )
    recent_count_result = client.call(
        f"{market['market']} health 90d count",
        build_payload(market=market, polygon=None, sold_min_date=min_date, take=0),
    )
    recent_sample_result = client.call(
        f"{market['market']} health 90d sample",
        build_payload(market=market, polygon=None, sold_min_date=min_date, take=10),
    )
    dates = [intel_last_sold_date(record) for record in recent_sample_result.records]
    dates = sorted(date for date in dates if date)
    newest = dates[-1] if dates else None
    lag_days = None
    if newest:
        lag_days = max(0, (datetime.now(timezone.utc).date() - datetime.fromisoformat(newest).date()).days)
    if lag_days is None:
        recommended = 90
    elif lag_days <= 14:
        recommended = 30
    elif lag_days <= 30:
        recommended = 60
    elif lag_days <= 60:
        recommended = 90
    else:
        recommended = 180
    return {
        "sold_min_date": min_date,
        "total_properties_in_area": total_result.total,
        "properties_sold_last_90_days": recent_count_result.total,
        "recent_sample_returned": recent_sample_result.returned,
        "newest_sale_date_observed": newest,
        "estimated_freshness_lag_days": lag_days,
        "recommended_sold_window_days": recommended,
        "total_count": result_summary(total_result, None, 0),
        "recent_count": result_summary(recent_count_result, min_date, 0),
        "recent_sample": result_summary(recent_sample_result, min_date, 3),
    }


def run_polygon_intel_verify(client: BatchDataClient, market: dict[str, Any], sold_months: float, take: int) -> dict[str, Any]:
    min_date = iso_days_ago(sold_window_days(sold_months))
    probe_a = client.call(
        f"{market['market']} probe A polygon lat/long + intel",
        build_payload(market=market, sold_min_date=min_date, take=take, coord_format="latitude_longitude"),
    )
    probe_b = client.call(
        f"{market['market']} probe B city/state + intel",
        build_payload(market=market, polygon=None, sold_min_date=min_date, take=take),
    )
    probe_c = client.call(
        f"{market['market']} probe C polygon lat/long no date",
        build_payload(market=market, sold_min_date=None, take=take, coord_format="latitude_longitude"),
    )
    probe_d = client.call(
        f"{market['market']} probe D polygon lat/lng + intel",
        build_payload(market=market, sold_min_date=min_date, take=take, coord_format="lat_lng"),
    )
    probe_e = client.call(
        f"{market['market']} probe E polygon lat/lng no date",
        build_payload(market=market, sold_min_date=None, take=take, coord_format="lat_lng"),
    )

    summaries = {
        "probe_a_polygon_intel": result_summary(probe_a, min_date, 3),
        "probe_b_citystate_intel": result_summary(probe_b, min_date, 3),
        "probe_c_polygon_no_date": result_summary(probe_c, None, 3),
        "probe_d_polygon_latlng_intel": result_summary(probe_d, min_date, 3),
        "probe_e_polygon_latlng_no_date": result_summary(probe_e, None, 3),
    }
    a_count = count_for_decision(summaries["probe_a_polygon_intel"])
    b_count = count_for_decision(summaries["probe_b_citystate_intel"])
    c_count = count_for_decision(summaries["probe_c_polygon_no_date"])
    a_outside = summaries["probe_a_polygon_intel"]["date_distribution"]["outside_window"]
    a_date_present = (
        summaries["probe_a_polygon_intel"]["date_distribution"]["provider_sale_date_present"]
        or summaries["probe_a_polygon_intel"]["date_distribution"]["intel_lastSoldDate_present"]
    )

    if a_count > 0 and not a_date_present:
        verdict = "DATE_FIELD_ABSENT_UNVERIFIABLE"
    elif a_count > 0 and a_outside == 0 and b_count > 0:
        verdict = "INTEL_WORKS_WITH_POLYGON"
    elif a_count > 0 and a_outside > 0:
        verdict = "SILENT_IGNORE_DETECTED"
    elif a_count == 0 and b_count > 0 and c_count > 0:
        verdict = "INTEL_INCOMPATIBLE_WITH_POLYGON"
    elif a_count == 0 and b_count == 0 and c_count > 0:
        verdict = "DATA_FRESHNESS_GAP"
    elif c_count == 0:
        verdict = "POLYGON_INVALID_OR_NO_DATA"
    else:
        verdict = "INCONCLUSIVE"

    d_count = count_for_decision(summaries["probe_d_polygon_latlng_intel"])
    e_count = count_for_decision(summaries["probe_e_polygon_latlng_no_date"])
    if probe_c.error and not probe_e.error:
        coordinate_verdict = "LAT_LNG_ACCEPTED_WHILE_LATITUDE_LONGITUDE_FAILED"
    elif not probe_c.error and probe_e.error:
        coordinate_verdict = "LATITUDE_LONGITUDE_ACCEPTED_WHILE_LAT_LNG_FAILED"
    elif c_count > 0 and e_count > 0:
        coordinate_verdict = "BOTH_COORDINATE_FORMATS_ACCEPTED"
    elif c_count > 0:
        coordinate_verdict = "LATITUDE_LONGITUDE_WORKS"
    elif e_count > 0:
        coordinate_verdict = "LAT_LNG_WORKS"
    elif a_count == 0 and d_count == 0:
        coordinate_verdict = "NO_COORDINATE_FORMAT_RETURNED_POLYGON_RESULTS"
    else:
        coordinate_verdict = "INCONCLUSIVE"

    return {
        "sold_min_date": min_date,
        "interpretation": verdict,
        "coordinate_format_verdict": coordinate_verdict,
        **summaries,
    }


def run_r2_coverage(client: BatchDataClient, market: dict[str, Any], sold_months: float, take: int) -> dict[str, Any]:
    min_date = iso_days_ago(sold_window_days(sold_months))
    r2_result = client.call(
        f"{market['market']} R2 coverage R2 pull",
        build_payload(market=market, sold_min_date=min_date, take=take, include_r2=True),
    )
    broad_result = client.call(
        f"{market['market']} R2 coverage broad pull",
        build_payload(market=market, sold_min_date=min_date, take=take),
    )
    r2_count = 0
    non_r2_sfr = 0
    noise_or_no_evidence = 0
    noise_correctly_excluded = 0
    samples_non_r2_sfr: list[dict[str, Any]] = []
    samples_noise: list[dict[str, Any]] = []

    for record in broad_result.records:
        fields = type_fields(record)
        is_r2 = fields["land_use"].upper() == "R2"
        explicit_sfr = is_explicit_sfr(fields["property_type"])
        noisy = has_noise_keyword(fields["property_type"], fields["land_use"])
        if is_r2:
            r2_count += 1
        elif explicit_sfr:
            non_r2_sfr += 1
            if len(samples_non_r2_sfr) < 5:
                samples_non_r2_sfr.append(raw_sample(record))
        else:
            noise_or_no_evidence += 1
            if noisy:
                noise_correctly_excluded += 1
            if len(samples_noise) < 5:
                samples_noise.append(raw_sample(record))

    broad_returned = broad_result.returned
    coverage = round((r2_count / broad_returned) * 100, 1) if broad_returned else None
    missing_land_use = sum(1 for record in broad_result.records if type_fields(record)["land_use"] == "missing")
    missing_land_use_pct = round((missing_land_use / broad_returned) * 100, 1) if broad_returned else None
    if coverage is None:
        recommendation = "INCONCLUSIVE_NO_BROAD_RECORDS"
    elif missing_land_use_pct is not None and missing_land_use_pct >= 80:
        recommendation = "BATCHDATA_R2_METADATA_UNAVAILABLE_USE_BROAD_PLUS_LOCAL_FILTERS"
    elif coverage >= 95:
        recommendation = "R2_FILTER_SAFE_FOR_THIS_MARKET"
    elif coverage >= 85:
        recommendation = "PR15_IMPORTANT_NON_R2_SFR_EXISTS_REVIEW_SAMPLES"
    else:
        recommendation = "PR15_CRITICAL_R2_FILTER_DROPS_TOO_MANY_RECORDS"

    return {
        "sold_min_date": min_date,
        "r2_pull": result_summary(r2_result, min_date, 3),
        "broad_pull": result_summary(broad_result, min_date, 3),
        "r2_count_in_broad_pull": r2_count,
        "r2_coverage_rate": coverage,
        "non_r2_sfr_count": non_r2_sfr,
        "non_r2_no_sfr_evidence_count": noise_or_no_evidence,
        "noise_correctly_excluded": noise_correctly_excluded,
        "missing_land_use_count": missing_land_use,
        "missing_land_use_pct": missing_land_use_pct,
        "non_r2_sfr_samples": samples_non_r2_sfr,
        "noise_samples": samples_noise,
        "recommendation": recommendation,
    }


def run_market_diagnostics(client: BatchDataClient, market: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    print(f"\n== {market['market']} diagnostics ==")
    result = {"market": market, "started_at": datetime.now(timezone.utc).isoformat()}
    result["raw_discovery"] = run_raw_discovery(client, market, args.sold_months, args.raw_take)
    print_progress(client, market["market"], "raw_discovery", result["raw_discovery"]["probe_with_date"])
    result["market_health_check"] = run_market_health(client, market)
    print_progress(client, market["market"], "market_health_check", result["market_health_check"]["recent_sample"])
    result["polygon_intel_verify"] = run_polygon_intel_verify(client, market, args.sold_months, args.verify_take)
    print(f"   polygon verdict: {result['polygon_intel_verify']['interpretation']} | coords: {result['polygon_intel_verify']['coordinate_format_verdict']}")
    result["r2_coverage_audit"] = run_r2_coverage(client, market, args.sold_months, args.r2_take)
    print(f"   R2 coverage: {result['r2_coverage_audit']['r2_coverage_rate']}% | {result['r2_coverage_audit']['recommendation']}")
    result["completed_at"] = datetime.now(timezone.utc).isoformat()
    result["credits_after_market"] = client.estimated_credits
    return result


def print_progress(client: BatchDataClient, market: str, step: str, summary: dict[str, Any]) -> None:
    print(
        f"   {step}: returned={summary.get('returned')} total={summary.get('total')} "
        f"credits={client.estimated_credits}/{client.budget} market={market}"
    )


def market_score(market_result: dict[str, Any]) -> float:
    health = market_result.get("market_health_check", {})
    sold90 = health.get("properties_sold_last_90_days") or 0
    lag = health.get("estimated_freshness_lag_days")
    lag_penalty = lag if isinstance(lag, int) else 120
    polygon = market_result.get("polygon_intel_verify", {})
    verdict_bonus = 1000 if polygon.get("interpretation") == "INTEL_WORKS_WITH_POLYGON" else 0
    return verdict_bonus + math.log10(max(1, sold90)) * 100 - lag_penalty


def summarize_deep_records(records: list[dict[str, Any]], min_date: str) -> dict[str, Any]:
    fields = [type_fields(record) for record in records]
    r2 = sum(1 for field in fields if field["land_use"].upper() == "R2")
    explicit_sfr = sum(1 for field in fields if is_explicit_sfr(field["property_type"]))
    noisy = sum(1 for field in fields if has_noise_keyword(field["property_type"], field["land_use"]))
    return {
        "returned": len(records),
        "date_distribution": date_distribution(records, min_date),
        "r2_count": r2,
        "explicit_sfr_count": explicit_sfr,
        "noise_keyword_count": noisy,
        "land_use_frequency": frequency_table(records, "land_use")[:10],
        "property_type_frequency": frequency_table(records, "property_type")[:10],
    }


def run_deep_pulls(
    client: BatchDataClient,
    market_results: list[dict[str, Any]],
    args: argparse.Namespace,
    output_dir: Path,
) -> list[dict[str, Any]]:
    if args.diagnostics_only:
        return []

    ranked = sorted(market_results, key=market_score, reverse=True)
    if args.deep_markets:
        ranked = ranked[: args.deep_markets]
    windows = [int(value.strip()) for value in args.deep_windows.split(",") if value.strip()]
    deep_path = output_dir / "deep_pull_records.jsonl.gz"
    deep_results: list[dict[str, Any]] = []
    print("\n== Deep pulls ==")

    with gzip.open(deep_path, "wt", encoding="utf-8") as handle:
        for market_result in ranked:
            market = market_result["market"]
            for days in windows:
                if client.remaining_budget() <= 0:
                    raise BudgetExceeded("Budget cap reached during deep pulls.")
                take = min(args.deep_take, BATCHDATA_MAX_TAKE, client.remaining_budget())
                if take <= 0:
                    break
                min_date = iso_days_ago(days)
                api_result = client.call(
                    f"{market['market']} deep {days}d skip 0",
                    build_payload(market=market, sold_min_date=min_date, take=take, skip=0),
                )
                for record in api_result.records:
                    handle.write(json.dumps({
                        "market": market["market"],
                        "city": market["city"],
                        "state": market["state"],
                        "window_days": days,
                        "skip": 0,
                        "record": record,
                    }, separators=(",", ":")) + "\n")
                summary = {
                    "market": market["market"],
                    "region": market["region"],
                    "state": market["state"],
                    "window_days": days,
                    "skip": 0,
                    "take": take,
                    "error": api_result.error,
                    "total": api_result.total,
                    "returned": api_result.returned,
                    "elapsed_ms": api_result.elapsed_ms,
                    "estimated_credits": api_result.estimated_credits,
                    **summarize_deep_records(api_result.records, min_date),
                }
                deep_results.append(summary)
                print(
                    f"   {market['market']} {days}d: returned={api_result.returned} "
                    f"total={api_result.total} credits={client.estimated_credits}/{client.budget}"
                )
                if api_result.error:
                    print(f"      error: {api_result.error[:200]}")
                if client.estimated_credits >= client.budget:
                    raise BudgetExceeded("Budget cap reached during deep pulls.")

    return deep_results


def flatten_market_summary(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for item in results:
        health = item.get("market_health_check", {})
        polygon = item.get("polygon_intel_verify", {})
        r2 = item.get("r2_coverage_audit", {})
        raw_probe = item.get("raw_discovery", {}).get("probe_with_date", {})
        raw_dates = raw_probe.get("date_distribution", {})
        rows.append({
            "market": item["market"]["market"],
            "region": item["market"]["region"],
            "type": item["market"]["type"],
            "state": item["market"]["state"],
            "total_properties": health.get("total_properties_in_area"),
            "sold_90_days": health.get("properties_sold_last_90_days"),
            "newest_sale_date": health.get("newest_sale_date_observed"),
            "freshness_lag_days": health.get("estimated_freshness_lag_days"),
            "recommended_window_days": health.get("recommended_sold_window_days"),
            "raw_returned": raw_probe.get("returned"),
            "intel_date_present_pct": raw_dates.get("intel_lastSoldDate_present_pct"),
            "provider_sale_date_present_pct": raw_dates.get("provider_sale_date_present_pct"),
            "silent_ignore": raw_dates.get("silent_ignore_indicator"),
            "polygon_intel_verdict": polygon.get("interpretation"),
            "coordinate_format_verdict": polygon.get("coordinate_format_verdict"),
            "r2_coverage_rate": r2.get("r2_coverage_rate"),
            "non_r2_sfr_count": r2.get("non_r2_sfr_count"),
            "noise_correctly_excluded": r2.get("noise_correctly_excluded"),
            "r2_recommendation": r2.get("recommendation"),
            "score": round(market_score(item), 2),
        })
    return rows


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def build_report(output_path: Path, rows: list[dict[str, Any]], deep_results: list[dict[str, Any]], metadata: dict[str, Any]) -> None:
    from docx import Document
    from docx.enum.section import WD_SECTION
    from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Inches, Pt, RGBColor

    doc = Document()
    section = doc.sections[0]
    section.top_margin = Inches(1)
    section.bottom_margin = Inches(1)
    section.left_margin = Inches(1)
    section.right_margin = Inches(1)
    section.header_distance = Inches(0.492)
    section.footer_distance = Inches(0.492)

    styles = doc.styles
    styles["Normal"].font.name = "Calibri"
    styles["Normal"].font.size = Pt(11)
    styles["Normal"].paragraph_format.space_after = Pt(6)
    styles["Normal"].paragraph_format.line_spacing = 1.10
    for style_name, size, color in (
        ("Heading 1", 16, RGBColor(0x2E, 0x74, 0xB5)),
        ("Heading 2", 13, RGBColor(0x2E, 0x74, 0xB5)),
        ("Heading 3", 12, RGBColor(0x1F, 0x4D, 0x78)),
    ):
        style = styles[style_name]
        style.font.name = "Calibri"
        style.font.size = Pt(size)
        style.font.color.rgb = color

    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.LEFT
    title_run = title.add_run("BatchData Nationwide Validation Report")
    title_run.bold = True
    title_run.font.name = "Calibri"
    title_run.font.size = Pt(20)
    title_run.font.color.rgb = RGBColor(0x0B, 0x25, 0x45)
    subtitle = doc.add_paragraph()
    subtitle.add_run(f"Generated {metadata['generated_at']} | Estimated credits used: {metadata['estimated_credits_used']:,} | Markets tested: {len(rows)}")

    doc.add_heading("Executive Decision", level=1)
    verdict_counts = Counter(row["polygon_intel_verdict"] for row in rows)
    r2_rates = [row["r2_coverage_rate"] for row in rows if isinstance(row.get("r2_coverage_rate"), (int, float))]
    avg_r2 = round(sum(r2_rates) / len(r2_rates), 1) if r2_rates else None
    compatible = verdict_counts.get("INTEL_WORKS_WITH_POLYGON", 0)
    silent_ignore = verdict_counts.get("SILENT_IGNORE_DETECTED", 0)
    critical_r2 = sum(1 for row in rows if str(row.get("r2_recommendation", "")).startswith("PR15_CRITICAL"))
    decision = doc.add_paragraph()
    if silent_ignore:
        decision.add_run("Do not merge PR #15 yet. ").bold = True
        decision.add_run(f"{silent_ignore} market(s) showed potential silent-ignore behavior on intel.lastSoldDate.")
    elif compatible >= max(1, len(rows) * 0.7) and critical_r2 == 0:
        decision.add_run("PR #15 is supported by the live-data validation set. ").bold = True
        decision.add_run("Proceed once app-level route-generation regression checks pass.")
    else:
        decision.add_run("PR #15 needs targeted review before merge. ").bold = True
        decision.add_run("The live-data results show mixed polygon/date compatibility or R2 coverage issues.")

    add_metric_table(doc, [
        ("Markets where polygon + intel works", f"{compatible}/{len(rows)}"),
        ("Silent-ignore detections", str(silent_ignore)),
        ("Average sampled R2 coverage", f"{avg_r2}%" if avg_r2 is not None else "n/a"),
        ("Critical R2 markets", str(critical_r2)),
        ("Deep pull records returned", f"{sum(item.get('returned', 0) for item in deep_results):,}"),
        ("API calls completed", str(metadata.get("api_calls", 0))),
    ])

    doc.add_heading("Per-Market Results", level=1)
    market_table_rows = [[
        row["market"],
        row["region"],
        str(row["sold_90_days"] if row["sold_90_days"] is not None else "n/a"),
        str(row["freshness_lag_days"] if row["freshness_lag_days"] is not None else "n/a"),
        str(row["polygon_intel_verdict"]),
        str(row["provider_sale_date_present_pct"]),
        f"{row['r2_coverage_rate']}%" if row["r2_coverage_rate"] is not None else "n/a",
        str(row["r2_recommendation"]),
    ] for row in rows]
    add_table(
        doc,
        ["Market", "Region", "90D Sold", "Lag", "Polygon Intel", "Date %", "R2", "R2 Verdict"],
        market_table_rows,
        [1650, 900, 850, 650, 1450, 1500, 600, 1760],
    )

    doc.add_heading("Nationwide Interpretation", level=1)
    add_bullets(doc, [
        f"intel.lastSoldDate + polygon compatibility: {compatible} of {len(rows)} markets returned a passing verdict.",
        f"Coordinate format result: {Counter(row['coordinate_format_verdict'] for row in rows).most_common(1)[0][0] if rows else 'n/a'}.",
        f"R2 filter coverage averaged {avg_r2 if avg_r2 is not None else 'n/a'} percent across markets with broad samples.",
        "Markets with low recent-sale counts should use the market health recommendation rather than forcing a short sold window.",
    ])

    doc.add_heading("Deep Pull Summary", level=1)
    if deep_results:
        deep_rows = [[
            item["market"],
            str(item["window_days"]),
            str(item.get("returned")),
            str(item.get("total") if item.get("total") is not None else "n/a"),
            str(item.get("date_distribution", {}).get("provider_sale_date_present_pct")),
            str(item.get("r2_count")),
            str(item.get("explicit_sfr_count")),
            str(item.get("noise_keyword_count")),
        ] for item in deep_results[:80]]
        add_table(
            doc,
            ["Market", "Days", "Returned", "Total", "Date %", "R2", "SFR", "Noise"],
            deep_rows,
            [1800, 650, 850, 850, 800, 700, 700, 700],
        )
        if len(deep_results) > 80:
            doc.add_paragraph(f"Deep pull table truncated in this report at 80 rows. Full results are in the JSON/CSV artifacts.")
    else:
        doc.add_paragraph("No deep pulls were run in this execution.")

    doc.add_heading("Merge Gates", level=1)
    gates = [
        ("Polygon + intel compatibility", "PASS" if silent_ignore == 0 and compatible > 0 else "REVIEW"),
        ("R2 quality coverage", "PASS" if critical_r2 == 0 else "REVIEW"),
        ("Coordinate format", "PASS" if all("FAILED" not in str(row["coordinate_format_verdict"]) for row in rows) else "REVIEW"),
        ("Data freshness messaging", "PASS" if any(row["recommended_window_days"] for row in rows) else "REVIEW"),
    ]
    add_table(doc, ["Gate", "Status"], [[gate, status] for gate, status in gates], [4200, 2400])

    doc.add_heading("Artifact Index", level=1)
    add_bullets(doc, [
        f"Results JSON: {metadata['results_json']}",
        f"Market summary CSV: {metadata['summary_csv']}",
        f"Deep records JSONL gzip: {metadata['deep_records_path']}",
        "The BatchData API key is not written into any artifact.",
    ])

    for section in doc.sections:
        footer = section.footer.paragraphs[0]
        footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        footer.add_run("FirstKnock BatchData validation")

    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                set_cell_margins(cell, top=80, bottom=80, start=120, end=120)
        set_table_geometry(table)

    # Keep the report portrait; no landscape section is needed with compact columns.
    doc.save(output_path)


def set_cell_margins(cell: Any, top: int, bottom: int, start: int, end: int) -> None:
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    tc_pr = cell._tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for name, value in (("top", top), ("bottom", bottom), ("start", start), ("end", end)):
        node = tc_mar.find(qn(f"w:{name}"))
        if node is None:
            node = OxmlElement(f"w:{name}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_table_geometry(table: Any) -> None:
    tbl_pr = table._tbl.tblPr
    tbl_w = tbl_pr.tblW
    tbl_w.type = "dxa"
    tbl_w.w = 9360
    table.autofit = False


def add_metric_table(doc: Any, rows: list[tuple[str, str]]) -> None:
    add_table(doc, ["Metric", "Value"], [[label, value] for label, value in rows], [4300, 3100])


def add_table(doc: Any, headers: list[str], rows: list[list[str]], widths: list[int]) -> None:
    from docx.shared import Pt, RGBColor

    table = doc.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    table.allow_autofit = False
    hdr = table.rows[0].cells
    for idx, header in enumerate(headers):
        cell = hdr[idx]
        cell.width = widths[idx]
        paragraph = cell.paragraphs[0]
        run = paragraph.add_run(header)
        run.bold = True
        run.font.size = Pt(9)
        run.font.color.rgb = RGBColor(0x0B, 0x25, 0x45)
        shade_cell(cell, "F2F4F7")
    for row_values in rows:
        cells = table.add_row().cells
        for idx, value in enumerate(row_values):
            cells[idx].width = widths[idx]
            run = cells[idx].paragraphs[0].add_run(str(value))
            run.font.size = Pt(8)
    doc.add_paragraph()


def shade_cell(cell: Any, fill: str) -> None:
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    tc_pr = cell._tc.get_or_add_tcPr()
    shade = OxmlElement("w:shd")
    shade.set(qn("w:fill"), fill)
    tc_pr.append(shade)


def add_bullets(doc: Any, items: list[str]) -> None:
    for item in items:
        doc.add_paragraph(item, style="List Bullet")


def save_results(output_dir: Path, results: list[dict[str, Any]], deep_results: list[dict[str, Any]], metadata: dict[str, Any]) -> dict[str, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    results_path = output_dir / "nationwide_validation_results.json"
    summary_path = output_dir / "market_summary.csv"
    deep_path = output_dir / "deep_pull_summary.csv"
    rows = flatten_market_summary(results)
    payload = {"metadata": metadata, "markets": results, "deep_results": deep_results, "market_summary": rows}
    results_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    write_csv(summary_path, rows)
    write_csv(deep_path, deep_results)
    return {"results_json": results_path, "summary_csv": summary_path, "deep_summary_csv": deep_path}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run nationwide BatchData validation probes.")
    parser.add_argument("--budget", type=int, default=30000, help="Estimated credit budget cap.")
    parser.add_argument("--limit-markets", type=int, default=0, help="Limit markets for smoke tests. 0 means all markets.")
    parser.add_argument("--smoke-test", action="store_true", help="Run the first 3 markets in diagnostics-only mode.")
    parser.add_argument("--diagnostics-only", action="store_true", help="Skip deep pulls.")
    parser.add_argument("--sold-months", type=float, default=3)
    parser.add_argument("--raw-take", type=int, default=25)
    parser.add_argument("--verify-take", type=int, default=25)
    parser.add_argument("--r2-take", type=int, default=50)
    parser.add_argument("--deep-markets", type=int, default=10)
    parser.add_argument("--deep-take", type=int, default=500)
    parser.add_argument("--deep-windows", default="7,14,30,90")
    parser.add_argument("--sleep", type=float, default=0.15)
    parser.add_argument("--output-dir", default="batchdata_results")
    parser.add_argument("--no-report", action="store_true", help="Skip DOCX report generation.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    api_key = os.environ.get("BATCHDATA_API_KEY") or os.environ.get("BATCH_DATA_API_KEY")
    if not api_key:
        print("BATCHDATA_API_KEY or BATCH_DATA_API_KEY must be set in the environment.", file=sys.stderr)
        return 2

    slug = now_slug()
    if args.smoke_test:
        args.limit_markets = args.limit_markets or 3
        args.diagnostics_only = True
        print("[SMOKE TEST] Running 3 markets, diagnostics only.")

    output_dir = Path(args.output_dir) / slug
    output_dir.mkdir(parents=True, exist_ok=True)
    markets = MARKETS[: args.limit_markets] if args.limit_markets else MARKETS
    client = BatchDataClient(api_key=api_key, budget=args.budget, sleep_s=args.sleep)
    results: list[dict[str, Any]] = []
    deep_results: list[dict[str, Any]] = []

    metadata: dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "budget": args.budget,
        "markets_requested": len(markets),
        "diagnostics_only": args.diagnostics_only,
        "api_url": BATCHDATA_URL,
    }

    try:
        for market in markets:
            if client.remaining_budget() <= 0:
                raise BudgetExceeded("Budget cap reached before all market diagnostics completed.")
            results.append(run_market_diagnostics(client, market, args))
        deep_results = run_deep_pulls(client, results, args, output_dir)
    except BudgetExceeded as exc:
        print(f"\nBudget stop: {exc}")
    finally:
        metadata.update({
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "estimated_credits_used": client.estimated_credits,
            "api_calls": client.calls,
            "api_errors": client.errors,
        })
        paths = save_results(output_dir, results, deep_results, metadata)
        deep_records_path = output_dir / "deep_pull_records.jsonl.gz"
        metadata_for_report = {
            **metadata,
            "results_json": str(paths["results_json"]),
            "summary_csv": str(paths["summary_csv"]),
            "deep_records_path": str(deep_records_path),
        }
        if not args.no_report:
            report_path = output_dir / "batchdata_nationwide_validation_report.docx"
            build_report(report_path, flatten_market_summary(results), deep_results, metadata_for_report)
            metadata_for_report["report_docx"] = str(report_path)
            # Rewrite metadata with report path included.
            payload = json.loads(paths["results_json"].read_text(encoding="utf-8"))
            payload["metadata"] = metadata_for_report
            paths["results_json"].write_text(json.dumps(payload, indent=2), encoding="utf-8")

        print("\n== Validation complete ==")
        print(f"Output directory: {output_dir}")
        print(f"Estimated credits used: {client.estimated_credits:,}/{client.budget:,}")
        print(f"API calls: {client.calls} | API errors: {client.errors}")
        if not args.no_report:
            print(f"Report: {metadata_for_report['report_docx']}")
        print(f"Results JSON: {paths['results_json']}")
        print(f"Summary CSV: {paths['summary_csv']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
