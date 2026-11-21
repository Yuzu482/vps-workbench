import importlib.util
import io
from pathlib import Path
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("egress", Path(__file__).resolve().parents[1] / "Probe-RemoteEgress.py")
egress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(egress)


class EgressTests(unittest.TestCase):
    def test_address_family_and_invalid_response(self):
        self.assertEqual(egress.parse_address(" 203.0.113.1\n", 4), "203.0.113.1")
        self.assertIsNone(egress.parse_address("2001:db8::1", 4))
        self.assertIsNone(egress.parse_address("<html>error</html>", 4))

    def test_change_mismatch_and_missing_samples(self):
        observations = []
        for provider, family, _ in egress.ENDPOINTS:
            for number in (1, 2):
                value = None if family == 6 else "203.0.113.2" if provider == "ipify" and number == 2 else "203.0.113.1"
                observations.append(dict(round=number, provider=provider, family=family, address=value))
        summaries, disagreements = egress.summarize(observations, 2)
        self.assertEqual(summaries[0]["state"], "changed")
        self.assertEqual(summaries[1]["state"], "unchanged")
        self.assertTrue(all(item["state"] == "incomplete" for item in summaries[2:]))
        self.assertEqual(disagreements, [(4, 2)])

    def test_confirmation_before_curl_or_network(self):
        with self.assertRaises(SystemExit) as error:
            egress.main([])
        self.assertNotEqual(error.exception.code, 0)

    def run_samples(self, responses, *options):
        output = io.StringIO()
        with patch.object(egress.shutil, "which", return_value="curl"), \
             patch.object(egress, "request_address", side_effect=responses), \
             redirect_stdout(output):
            result = egress.main(["--on-vps", "--samples", "2", "--interval", "0", *options])
        return result, output.getvalue()

    def test_expected_addresses_require_every_requested_sample(self):
        samples = ["203.0.113.1", "203.0.113.1", "2001:db8::1", "2001:db8::1"] * 2
        code, output = self.run_samples(samples, "--expected-ipv4", "203.0.113.1",
                                        "--expected-ipv6", "2001:DB8:0:0:0:0:0:1")
        self.assertEqual(code, 0)
        self.assertIn("Expected IPv4: MATCHED", output)
        self.assertIn("Expected IPv6: MATCHED", output)
        self.assertIn("do not block traffic", output)

    def test_expected_mismatch_is_reported_even_if_other_samples_are_missing(self):
        samples = ["203.0.113.2", None, None, None, "203.0.113.1", "203.0.113.1", None, None]
        code, output = self.run_samples(samples, "--expected-ipv4", "203.0.113.1")
        self.assertEqual(code, 1)
        self.assertIn("ALERT: ipify IPv4 differs", output)
        self.assertLess(output.index("ALERT: ipify IPv4 differs"), output.index("Sampling 1/2: Cloudflare IPv4"))
        self.assertIn("Expected IPv4: MISMATCH", output)

    def test_expected_missing_sample_is_incomplete(self):
        samples = ["203.0.113.1", None, None, None, "203.0.113.1", "203.0.113.1", None, None]
        code, output = self.run_samples(samples, "--expected-ipv4", "203.0.113.1")
        self.assertEqual(code, 2)
        self.assertIn("Expected IPv4: INCOMPLETE", output)
        self.assertNotIn("Expected IPv4: MATCHED", output)

    def test_expected_ipv6_cannot_be_verified_by_successful_ipv4(self):
        samples = ["203.0.113.1", "203.0.113.1", None, None] * 2
        code, output = self.run_samples(samples, "--expected-ipv4", "203.0.113.1",
                                        "--expected-ipv6", "2001:db8::1")
        self.assertEqual(code, 2)
        self.assertIn("Expected IPv4: MATCHED", output)
        self.assertIn("Expected IPv6: INCOMPLETE", output)

    def test_unrequested_family_and_existing_exit_behavior(self):
        samples = ["203.0.113.1", "203.0.113.1", None, None] * 2
        code, _ = self.run_samples(samples, "--expected-ipv4", "203.0.113.1")
        self.assertEqual(code, 0)
        code, _ = self.run_samples(samples)
        self.assertEqual(code, 0)
        code, _ = self.run_samples([None] * 8)
        self.assertEqual(code, 2)

    def test_invalid_expected_address_never_starts_sampling(self):
        with patch.object(egress.shutil, "which") as find_curl, redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                egress.main(["--on-vps", "--expected-ipv4", "2001:db8::1"])
        self.assertNotEqual(error.exception.code, 0)
        find_curl.assert_not_called()

    def test_change_and_provider_disagreement_are_reported_during_sampling(self):
        samples = ["203.0.113.1", "203.0.113.1", None, None,
                   "203.0.113.2", "203.0.113.1", None, None]
        code, output = self.run_samples(samples)
        self.assertEqual(code, 0)  # No expected address retains the original exit behavior.
        self.assertIn("ALERT: ipify IPv4 changed since its previous successful sample.", output)
        self.assertIn("ALERT: IPv4 providers differ in sample 2.", output)
        self.assertLess(output.index("ALERT: ipify IPv4 changed"), output.index("Sampling 2/2: Cloudflare IPv4"))
        self.assertLess(output.index("ALERT: IPv4 providers differ"), output.index("Sampling 2/2: ipify IPv6"))

    def test_unavailable_sample_is_reported_immediately(self):
        samples = [None, "203.0.113.1", None, None] * 2
        code, output = self.run_samples(samples)
        self.assertEqual(code, 0)
        self.assertIn("WARNING: ipify IPv4 sample 1 was unavailable; cause unknown.", output)
        self.assertLess(output.index("WARNING: ipify IPv4 sample 1"), output.index("Sampling 1/2: Cloudflare IPv4"))

    def test_required_consistency_accepts_only_complete_matching_samples(self):
        stable = ["203.0.113.1", "203.0.113.1", None, None] * 2
        code, output = self.run_samples(stable, "--require-consistent-ipv4")
        self.assertEqual(code, 0)
        self.assertIn("IPv4 consistency: CONSISTENT", output)
        code, output = self.run_samples(stable, "--require-consistent-ipv6")
        self.assertEqual(code, 2)
        self.assertIn("IPv6 consistency: INCOMPLETE", output)
        changed = ["203.0.113.1", "203.0.113.1", None, None,
                   "203.0.113.2", "203.0.113.1", None, None]
        code, output = self.run_samples(changed, "--require-consistent-ipv4")
        self.assertEqual(code, 1)
        self.assertIn("IPv4 consistency: INCONSISTENT", output)

    def test_expected_and_consistency_conditions_are_both_enforced(self):
        samples = ["203.0.113.1", "203.0.113.1", None, None] * 2
        code, output = self.run_samples(samples, "--expected-ipv4", "203.0.113.1",
                                        "--require-consistent-ipv6")
        self.assertEqual(code, 2)
        self.assertIn("Expected IPv4: MATCHED", output)
        self.assertIn("IPv6 consistency: INCOMPLETE", output)


if __name__ == "__main__":
    unittest.main()
