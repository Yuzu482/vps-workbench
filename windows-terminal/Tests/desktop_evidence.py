"""Local-demo observations only. Never treat received text as IME/UI proof."""
import json
import re
from datetime import datetime, timezone


class DesktopEvidence:
    def __init__(self):
        self._output = bytearray()
        self.truncated = False

    def observe(self, data):
        remaining = 1024 * 1024 - len(self._output)
        self._output.extend(data[:remaining])
        self.truncated |= len(data) > remaining

    def snapshot(self, fixture, result, error_type=None):
        text = self._output.decode("utf-8", "replace")
        text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
        text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text).replace("\r", "\n")
        def line(value):
            return re.search(r"^" + re.escape(value) + r"[ \t]*$", text, re.MULTILINE) is not None
        sizes = sorted(set(re.findall(r"^MOCK-SIZE:(\d+x\d+)[ \t]*$", text, re.MULTILINE)))
        server = getattr(fixture, "server", None)
        return {
            "schema": 1,
            "recorded_at_utc": datetime.now(timezone.utc).isoformat(),
            "scope": "local_demo_only_not_vps_or_claude",
            "cleanup_scope": "Fixture server, remote test processes, listener and temporary keys; does not certify Windows Terminal window closure",
            "result": result,
            "error_type": error_type,
            "observations": {
                "authenticated": bool(server and server.authenticated),
                "pty_requested": bool(server and server.pty),
                "shell_requested": bool(server and server.shell.is_set()),
                "fixture_ready": line("LOCAL-SSH-READY"),
                "chinese_echo": line("MOCK-ECHO:中文输入测试"),
                "right_arrow": line("MOCK-SELECTION:DENY"),
                "tab": line("MOCK-TAB"),
                "enter_deny": line("MOCK-DECISION:DENY"),
                "ctrl_c": line("MOCK-CTRL-C"),
                "reported_sizes": sizes,
                "size_changed": len(sizes) >= 2,
                "remote_fixture_exit_code": getattr(fixture, "remote_exit_code", None),
                "cleanup_verified": bool(getattr(fixture, "cleanup_verified", False)),
                "capture_limit_reached": self.truncated,
            },
            "manual_confirmation_required": ["Windows Terminal visible and correctly rendered", "Real Pinyin composition and candidate selection, not paste"],
        }

    def save(self, path, fixture, result, error_type=None):
        path.parent.mkdir(parents=True, exist_ok=True)
        # Save only fixed booleans, dimensions, exit status and error class.
        # Do not save terminal transcripts, input text, key paths or credentials.
        report = self.snapshot(fixture, result, error_type)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
