#!/usr/bin/env python3
"""Sample the machine's IPv4/IPv6 egress from two public IP services.

Run only on the VPS. The contacted services see its source address. This is not
proof that another application or destination follows the same network route.
"""
import argparse
import ipaddress
import os
import shutil
import subprocess
import sys
import time

ENDPOINTS = (
    ("ipify", 4, "https://api.ipify.org/"),
    ("Cloudflare", 4, "https://ipv4.icanhazip.com/"),
    ("ipify", 6, "https://api6.ipify.org/"),
    ("Cloudflare", 6, "https://ipv6.icanhazip.com/"),
)


def parse_address(value, family):
    try:
        address = ipaddress.ip_address(value.strip())
        return str(address) if address.version == family else None
    except ValueError:
        return None


def request_address(curl, family, url):
    try:
        result = subprocess.run(
            [curl, f"-{family}", "--fail", "--silent", "--show-error",
             "--connect-timeout", "5", "--max-time", "8", "--max-filesize", "1024", "--", url],
            capture_output=True, text=True, timeout=10, check=False,
        )
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        return None
    if result.returncode or len(result.stdout) > 100:
        return None
    return parse_address(result.stdout, family)


def summarize(observations, samples):
    summaries = []
    for provider, family, _ in ENDPOINTS:
        entries = [x for x in observations if x["provider"] == provider and x["family"] == family]
        values = [x["address"] for x in entries if x["address"] is not None]
        unique = list(dict.fromkeys(values))
        state = "changed" if len(unique) > 1 else "incomplete" if len(values) != samples else "unchanged"
        summaries.append(dict(provider=provider, family=family, state=state,
                              successful=len(values), expected=samples, addresses=unique))
    disagreements = []
    for family in (4, 6):
        for round_number in range(1, samples + 1):
            values = {x["address"] for x in observations if x["family"] == family
                      and x["round"] == round_number and x["address"] is not None}
            if len(values) > 1:
                disagreements.append((family, round_number))
    return summaries, disagreements


def check_expectations(summaries, expected_addresses):
    checks = []
    for family, expected_address in expected_addresses.items():
        entries = [item for item in summaries if item["family"] == family]
        mismatched = any(address != expected_address for item in entries for address in item["addresses"])
        incomplete = len(entries) != 2 or any(item["successful"] != item["expected"] for item in entries)
        state = "mismatch" if mismatched else "incomplete" if incomplete else "matched"
        checks.append(dict(family=family, state=state))
    return checks


def check_consistency(summaries, family):
    entries = [item for item in summaries if item["family"] == family]
    addresses = {address for item in entries for address in item["addresses"]}
    incomplete = len(entries) != 2 or any(item["successful"] != item["expected"] for item in entries)
    state = "mismatch" if len(addresses) > 1 else "incomplete" if incomplete or not addresses else "matched"
    return dict(family=family, state=state)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Sample the current machine's public IPv4/IPv6 egress.")
    parser.add_argument("--on-vps", action="store_true", help="Confirm this command runs on the VPS")
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--interval", type=int, default=5)
    parser.add_argument("--expected-ipv4", help="Compare every IPv4 sample with this expected address")
    parser.add_argument("--expected-ipv6", help="Compare every IPv6 sample with this expected address")
    parser.add_argument("--require-consistent-ipv4", action="store_true", help="Require complete, consistent IPv4 samples")
    parser.add_argument("--require-consistent-ipv6", action="store_true", help="Require complete, consistent IPv6 samples")
    args = parser.parse_args(argv)
    if not args.on_vps:
        parser.error("Run this on the VPS and pass --on-vps; third-party services will see its source IP")
    if not 1 <= args.samples <= 20 or not 0 <= args.interval <= 3600:
        parser.error("samples must be 1-20 and interval 0-3600 seconds")
    expected_addresses = {}
    for family, value in ((4, args.expected_ipv4), (6, args.expected_ipv6)):
        if value is not None:
            address = parse_address(value, family)
            if address is None or "%" in address:
                parser.error(f"--expected-ipv{family} must be an IPv{family} address without a scope")
            expected_addresses[family] = address
    curl = shutil.which("curl")
    if curl is None:
        parser.error("curl is required on the VPS")
    print("ipify and Cloudflare will see this machine's egress address. No Anthropic request is made.", flush=True)
    print("Other programs and destinations may use a different route or proxy.", flush=True)
    if expected_addresses or args.require_consistent_ipv4 or args.require_consistent_ipv6:
        print("Address checks cover only the specified families and samples; they do not block traffic or verify other programs.", flush=True)
    proxy_names = [name for name in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
                   "https_proxy", "http_proxy", "all_proxy", "no_proxy") if os.environ.get(name)]
    print("Proxy variable names: " + (", ".join(proxy_names) if proxy_names else "none observed"), flush=True)
    observations = []
    previous_addresses = {}
    for round_number in range(1, args.samples + 1):
        if round_number > 1 and args.interval:
            time.sleep(args.interval)
        round_addresses = {}
        for provider, family, url in ENDPOINTS:
            print(f"Sampling {round_number}/{args.samples}: {provider} IPv{family}", flush=True)
            address = request_address(curl, family, url)
            observations.append(dict(round=round_number, provider=provider, family=family,
                                     address=address))
            if address is None:
                print(f"WARNING: {provider} IPv{family} sample {round_number} was unavailable; cause unknown.", flush=True)
                continue
            key = (provider, family)
            if key in previous_addresses and address != previous_addresses[key]:
                print(f"ALERT: {provider} IPv{family} changed since its previous successful sample.", flush=True)
            previous_addresses[key] = address
            if family in round_addresses and address != round_addresses[family]:
                print(f"ALERT: IPv{family} providers differ in sample {round_number}.", flush=True)
            round_addresses[family] = address
            if family in expected_addresses and address != expected_addresses[family]:
                print(f"ALERT: {provider} IPv{family} differs from the expected address in sample {round_number}.", flush=True)
    summaries, disagreements = summarize(observations, args.samples)
    labels = {"changed": "CHANGED during sampling", "incomplete": "INCOMPLETE; cause unknown",
              "unchanged": "unchanged in these samples; long-term stability not established"}
    for item in summaries:
        addresses = ", ".join(item["addresses"]) or "unavailable"
        print(f"{item['provider']} IPv{item['family']}: {item['successful']}/{item['expected']}; "
              f"{labels[item['state']]}; {addresses}")
    for family, round_number in disagreements:
        print(f"Different IPv{family} addresses reported by the two providers in sample {round_number}.")
    checks = check_expectations(summaries, expected_addresses)
    check_labels = {"matched": "MATCHED in all requested samples",
                    "mismatch": "MISMATCH observed",
                    "incomplete": "INCOMPLETE; expected address was not fully verified"}
    for check in checks:
        print(f"Expected IPv{check['family']}: {check_labels[check['state']]}")
    consistency_checks = [check_consistency(summaries, family) for family, required in
                          ((4, args.require_consistent_ipv4), (6, args.require_consistent_ipv6)) if required]
    consistency_labels = {"matched": "CONSISTENT in all requested samples",
                          "mismatch": "INCONSISTENT addresses observed",
                          "incomplete": "INCOMPLETE; consistency was not verified"}
    for check in consistency_checks:
        print(f"IPv{check['family']} consistency: {consistency_labels[check['state']]}")
    checks.extend(consistency_checks)
    print("An unsuccessful IPv6 request does not prove IPv6 is disabled.")
    if checks:
        if any(check["state"] == "mismatch" for check in checks):
            return 1
        if any(check["state"] == "incomplete" for check in checks):
            return 2
        return 0
    return 0 if any(item["successful"] for item in summaries) else 2


if __name__ == "__main__":
    sys.exit(main())
