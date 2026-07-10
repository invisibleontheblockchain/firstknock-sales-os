import contextlib
import importlib.util
import io
import sys
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "batchdata_nationwide_validation.py"
SPEC = importlib.util.spec_from_file_location("batchdata_nationwide_validation", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def record(property_id, street):
    return {
        "property": {
            "ids": {"propertyId": property_id},
            "address": {
                "street": street,
                "city": "Phoenix",
                "state": "AZ",
                "zip": "85001",
                "latitude": 33.45,
                "longitude": -112.07,
            },
            "owner": {"fullName": "Synthetic Owner"},
        }
    }


class FakeClient:
    def __init__(self):
        self.calls = []

    @property
    def remaining_budget(self):
        return 999

    def post_search(self, payload):
        self.calls.append(payload)
        criteria = payload["searchCriteria"]
        if "intel" in criteria:
            records = [record("shared", "1 Test Ave"), record("intel-only", "2 Test Ave")]
        else:
            records = [record("shared", "1 Test Ave"), record("sale-only", "3 Test Ave")]
        return MODULE.ApiResult(ok=True, status=200, records=records, total=2)


class NationwideValidationTests(unittest.TestCase):
    def test_default_invocation_is_plan_only_with_conservative_limits(self):
        args = MODULE.parse_args([])
        self.assertFalse(args.confirm_live)
        self.assertEqual(args.budget, 500)
        self.assertEqual(args.page_size, 100)
        self.assertEqual(MODULE.LIVE_PAGE_MAX, 100)

    def test_plan_only_main_makes_no_network_request(self):
        with patch.object(MODULE.urllib.request, "urlopen", side_effect=AssertionError("network called")):
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(MODULE.main(["--limit-cities", "1", "--windows", "1"]), 0)

    def test_payload_uses_contract_correct_datasets_and_qualified_filters(self):
        city = MODULE.CITIES[0]
        intel = MODULE.build_search_payload(
            city, "intel", "2026-07-08", "2026-07-08", take=100, skip=0
        )
        sale = MODULE.build_search_payload(
            city, "sale", "2026-06-25", "2026-07-08", take=25, skip=100
        )
        self.assertEqual(intel["options"]["datasets"], ["basic"])
        self.assertEqual(intel["options"]["take"], 100)
        self.assertEqual(
            intel["searchCriteria"]["intel"]["lastSoldDate"],
            {"minDate": "2026-07-08", "maxDate": "2026-07-08"},
        )
        self.assertEqual(
            sale["searchCriteria"]["sale"]["lastSaleDate"],
            {"minDate": "2026-06-25", "maxDate": "2026-07-08"},
        )
        self.assertEqual(sale["searchCriteria"]["general"]["standardizedLandUseCode"]["equals"], "R2")
        self.assertEqual(sale["searchCriteria"]["valuation"]["estimatedValue"]["min"], 100_000)
        self.assertEqual(
            sale["searchCriteria"]["listing"]["statusCategory"]["notInList"],
            ["Active", "Pending"],
        )

    def test_payload_rejects_pages_over_live_limit(self):
        with self.assertRaises(ValueError):
            MODULE.build_search_payload(
                MODULE.CITIES[0], "intel", "2026-07-01", "2026-07-08", take=101, skip=0
            )

    def test_city_window_paginates_independent_streams_then_unions_records(self):
        args = SimpleNamespace(
            page_size=100,
            max_pages_per_stream=5,
            broad=False,
            min_value=100_000,
            max_value=None,
            sample_limit=5,
            sensitive_output=False,
        )
        client = FakeClient()
        result = MODULE.run_city_window(client, MODULE.CITIES[2], 14, date(2026, 7, 8), args)
        self.assertEqual(len(client.calls), 2)
        self.assertIn("intel", client.calls[0]["searchCriteria"])
        self.assertIn("sale", client.calls[1]["searchCriteria"])
        self.assertTrue(result["union"]["complete"])
        self.assertEqual(result["union"]["sampled_or_exact_count"], 3)
        self.assertEqual(result["union"]["overlap"], 1)
        self.assertEqual(result["union"]["intel_only"], 1)
        self.assertEqual(result["union"]["sale_only"], 1)

    def test_default_samples_do_not_persist_address_id_owner_or_raw_record(self):
        entry = {
            "identity": "provider:secret-id",
            "record": record("secret-id", "123 Private Ave"),
            "sources": {"intel", "sale"},
        }
        safe = MODULE.safe_sample(entry, sensitive_output=False)
        serialized = str(safe)
        self.assertNotIn("123 Private Ave", serialized)
        self.assertNotIn("secret-id", serialized)
        self.assertNotIn("Synthetic Owner", serialized)
        self.assertNotIn("raw_provider_record", serialized)
        self.assertEqual(len(safe["identity_sha256"]), 64)
        sensitive = MODULE.safe_sample(entry, sensitive_output=True)
        self.assertIn("raw_provider_record", sensitive["sensitive"])


if __name__ == "__main__":
    unittest.main()
