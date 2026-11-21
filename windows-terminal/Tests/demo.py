"""One disposable local SSH session, opened by the user for desktop/IME checks."""
import hashlib
import base64
import json
import subprocess
import time
from loopback import Fixture, ROOT
from desktop_evidence import DesktopEvidence


def run():
    manager = None
    evidence = DesktopEvidence()
    fixture = Fixture(observe_output=evidence.observe)
    result, error_type = "incomplete", None
    report = ROOT / "artifacts/desktop-verification.json"
    try:
        with fixture:
            profile = fixture.work / "connection.json"
            profile.write_text(json.dumps(fixture.profile, ensure_ascii=False), encoding="utf-8")
            digest = base64.b64encode(hashlib.sha256(fixture.host.asbytes()).digest()).decode().rstrip("=")
            print("Local SSH demo only; no Codex or external host.", flush=True)
            print(f"Target: loopback@127.0.0.1:{fixture.port}", flush=True)
            print("Temporary fixture fingerprint: SHA256:" + digest, flush=True)
            print("The manager is prefilled. Confirm the local fixture record, then open SSH.", flush=True)
            print("Use Pinyin to type: 中文输入测试", flush=True)
            print("Then: keys, Right arrow, Tab, Enter; Ctrl+C; size, resize the window, size; quit.", flush=True)
            print("Only test-result flags are saved. Real IME and visible rendering still need your confirmation.", flush=True)
            manager = subprocess.Popen([str(ROOT / "artifacts/app/RemoteSsh.Manager.exe"), "--profile", str(profile)])
            end = time.monotonic() + 1200
            while manager.poll() is None and fixture.thread.is_alive() and time.monotonic() < end:
                time.sleep(0.2)
            result = "session_ended" if not fixture.thread.is_alive() else "manager_closed" if manager.poll() is not None else "timeout"
    except BaseException as exc:
        result, error_type = "cancelled" if isinstance(exc, KeyboardInterrupt) else "error", type(exc).__name__
        raise
    finally:
        try:
            if manager and manager.poll() is None:
                manager.terminate(); manager.wait(timeout=5)
        finally:
            evidence.save(report, fixture, result, error_type)
            print("Local test report: " + str(report), flush=True)
    print("Local demo ended; fixture server, remote test processes and keys cleaned up.", flush=True)
    print("If an SSH error terminal is paused, press a key there to close it.", flush=True)


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        print("Local demo cancelled; cleanup completed.", flush=True)
