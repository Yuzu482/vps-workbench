"""Prepare an isolated SSH/WSL fixture for manual or CUA manager GUI testing.

This helper never opens the manager. It keeps a generated loopback SSH server
alive until the controller creates finish.signal, then verifies and cleans up
the finished test task. No real VPS or pre-existing credentials are used.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

import managed_loopback_wsl as managed


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def main():
    if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != "--run-start"):
        raise ValueError("Expected a new fixture output directory and optional --run-start")
    run_start = len(sys.argv) == 3
    directory = Path(sys.argv[1]).resolve(strict=False)
    if not directory.is_absolute() or directory.exists():
        raise ValueError("Fixture output directory must not already exist")
    directory.mkdir()
    remote_root = "/tmp/remote-managed-ui-" + uuid.uuid4().hex
    state_dir = remote_root + "/tasks"
    receipt = directory / "receipt.json"
    try:
        with managed.ExecFixture(state_dir) as fixture:
            config = fixture.work / "prepare.json"
            config.write_text(json.dumps({"host": "127.0.0.1", "port": fixture.port,
                                          "identity": fixture.profile["IdentityPath"],
                                          "known": fixture.profile["KnownHostsPath"],
                                          "receipt": str(receipt), "state_root": state_dir,
                                          "app": str(managed.APP), "python": "python.exe",
                                          "side_effect": remote_root + "/once.txt", "prepare_only": True}),
                              encoding="utf-8")
            if not run_start:
                prepared = subprocess.run([str(managed.HARNESS), str(config)], capture_output=True, timeout=60, check=False)
                if prepared.returncode or not receipt.is_file() or not fixture.dropped:
                    raise RuntimeError("Could not prepare a task with a lost acknowledgement")
            host_fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(fixture.host.asbytes()).digest()).decode().rstrip("=")
            keygen = Path(os.environ["SystemRoot"]) / "System32" / "OpenSSH" / "ssh-keygen.exe"
            verify = subprocess.run([str(keygen), "-lf", fixture.profile["KnownHostsPath"]],
                                    capture_output=True, timeout=10, check=True)
            if host_fingerprint not in verify.stdout.decode("utf-8"):
                raise RuntimeError("Generated fixture host fingerprint does not match known_hosts")
            target = {"host": "127.0.0.1", "port": fixture.port, "user": "loopback",
                      "identity": fixture.profile["IdentityPath"], "known": fixture.profile["KnownHostsPath"],
                      "fingerprint": host_fingerprint, "receipt": str(receipt), "state_dir": state_dir,
                      "side_effect": remote_root + "/once.txt"}
            write_json(directory / "ready.json", target)
            print("FIXTURE_READY " + str(directory / "ready.json"), flush=True)
            if run_start:
                gui_test = managed.ROOT / "ManagerGuiTests" / "bin" / "Release" / "net10.0-windows" / "ManagerGuiTests.exe"
                tested = subprocess.run([str(gui_test), str(directory / "ready.json"), "--start"],
                                        capture_output=True, timeout=100, check=False)
                print(tested.stdout.decode("utf-8", errors="replace"), end="", flush=True)
                if tested.returncode:
                    raise RuntimeError("GUI component test failed: " + tested.stderr.decode("utf-8", errors="replace")[-2500:])
                (directory / "finish.signal").touch(exist_ok=False)
            deadline = time.monotonic() + 420
            while time.monotonic() < deadline and not (directory / "finish.signal").exists():
                time.sleep(0.2)
            if not (directory / "finish.signal").exists():
                raise RuntimeError("GUI test did not finish before the fixture deadline")
            if fixture.actions.count("start") != 1 or "status" not in fixture.actions:
                raise RuntimeError("Expected exactly one start and at least one status query")
            identifier = json.loads(receipt.read_text(encoding="utf-8"))["task_id"]
            cleared = managed.cleanup(remote_root, identifier)
            if cleared.returncode:
                raise RuntimeError("Linux task state or the single side effect did not verify")
            result = {"lost_ack": fixture.dropped, "starts": fixture.actions.count("start"),
                      "queries": fixture.actions.count("status"), "output_reads": fixture.actions.count("output"),
                      "side_effect_once": True, "linux_state_cleaned": True}
        receipt.unlink()
        (directory / "finish.signal").unlink()
        (directory / "ready.json").unlink()
        result["test_keys_cleaned"] = True
        result["local_receipt_cleaned"] = True
        write_json(directory / "result.json", result)
        print("FIXTURE_VERIFIED " + json.dumps(result), flush=True)
    except BaseException:
        print("FIXTURE_ERROR retained receipt and possible Linux state: " + str(directory) + " " + remote_root,
              file=sys.stderr, flush=True)
        raise


if __name__ == "__main__":
    main()
