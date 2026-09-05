#!/usr/bin/env python3
"""Local POSIX PTY acceptance for the real compiled CLI + injected fixture.
Run after pnpm build: python3 scripts/verify-tui-pty.py
No network, provider credentials, pyte dependency, or private project data.
"""
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

REPO = Path(__file__).resolve().parent.parent


class Probe:
    def __init__(self, root, extra=()):
        self.master, self.slave = pty.openpty()
        self.before = termios.tcgetattr(self.slave)
        self.resize(100, 24, notify=False)
        self.proc = subprocess.Popen(
            ["node", str(REPO / "scripts/tui-pty-fixture.mjs"), str(root), *extra],
            cwd=REPO, stdin=self.slave, stdout=self.slave, stderr=self.slave,
            start_new_session=True,
            # Keep the parent's slave usable after child exit (macOS revokes a
            # session leader's controlling tty on exit). Node operates on the
            # inherited tty descriptors; resize signals are delivered explicitly.
        )
        self.raw = ""
        self.pending = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.lines = {}
        self.row = 0
        self.column = 0

    def resize(self, columns, rows, notify=True):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        if notify:
            self.lines = {}
            os.kill(self.proc.pid, signal.SIGWINCH)

    def read(self, timeout=0.1):
        if not select.select([self.master], [], [], timeout)[0]:
            return
        try:
            data = os.read(self.master, 65536)
        except OSError:
            return
        text = self.decoder.decode(data)
        self.raw += text
        self.pending += text
        # Observe only the adapter's cursor/erase protocol, not emulator colors.
        while self.pending:
            if self.pending.startswith("\x1b"):
                match = re.match(r"\x1b\[([0-9;?]*)([@-~])", self.pending)
                if not match:
                    break
                args, final = match.groups()
                self.pending = self.pending[match.end():]
                if final == "H":
                    coords = [int(x or 1) for x in args.split(";")]
                    self.row, self.column = coords[0] - 1, (coords[1] if len(coords) > 1 else 1) - 1
                if final == "K":
                    self.lines[self.row] = ""
                if final == "J":
                    self.lines = {}
                continue
            end = self.pending.find("\x1b")
            part = self.pending if end == -1 else self.pending[:end]
            self.pending = "" if end == -1 else self.pending[end:]
            self.lines[self.row] = self.lines.get(self.row, "")[:self.column] + part
            self.column += len(part)

    @property
    def screen(self):
        return "\n".join(self.lines.get(row, "") for row in sorted(self.lines))

    def wait(self, predicate, label, timeout=6):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.read()
            if predicate():
                return
            if self.proc.poll() is not None:
                break
        raise AssertionError(f"{label}: exit={self.proc.poll()} screen={self.screen!r} raw_tail={self.raw[-1000:]!r}")

    def send(self, text):
        os.write(self.master, text.encode())

    def exit(self, sig=None, key="\x04"):
        if sig:
            os.kill(self.proc.pid, sig)
        else:
            self.send(key)
        self.wait(lambda: self.proc.poll() is not None, "clean exit")
        self.read(0)
        assert self.proc.returncode == 0, self.raw[-3000:]
        for restore in ["\x1b[?2004l", "\x1b[?25h", "\x1b[?1049l"]:
            assert restore in self.raw, repr(restore)
        after = termios.tcgetattr(self.slave)
        mask = termios.ICANON | termios.ECHO | termios.ISIG
        assert after[3] & mask == self.before[3] & mask, "termios not restored"
        # The reclaimed slave accepts ordinary canonical line input.
        self.send("post-exit-input\n")
        assert select.select([self.slave], [], [], 2)[0], "canonical input unavailable"
        assert b"post-exit-input\n" in os.read(self.slave, 1024)

    def close(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=3)
        os.close(self.master)
        os.close(self.slave)


checks = []
with tempfile.TemporaryDirectory(prefix="dragons-m72-pty-") as directory:
    root = Path(directory)
    p = Probe(root)
    try:
        p.wait(lambda: "pty-fixture" in p.screen and "READY" in p.screen, "startup")
        p.send("draft-survives")
        p.wait(lambda: "draft-survives" in p.screen, "draft")
        p.resize(1, 1)
        # Wait for any resize frame without depending on text in a zero-width viewport.
        previous = len(p.raw)
        p.wait(lambda: len(p.raw) > previous, "tiny resize")
        p.resize(80, 24)
        p.wait(lambda: "draft-survives" in p.screen, "restored draft")
        p.send("\x01" + "\x1b[3~" * len("draft-survives") + "stream\r")
        p.wait(lambda: "Fixture stream part one." in p.screen, "stream first")
        p.wait(lambda: "Fixture stream part two." in p.screen and "READY" in p.screen, "stream completed")
        assert p.screen.count("Fixture stream part one.") == 1
        assert p.screen.count("Fixture stream part two.") == 1
        checks.append("resize/draft + live fixture streaming without duplicate final")
        p.send("write\r")
        p.wait(lambda: "PERMISSION: WRITE" in p.screen, "deny dialog")
        p.send("\x1b[200~\t\r\x1b[201~")
        p.send("\r")  # default is deny; pasted Tab/Enter cannot select approval
        p.wait(lambda: "WRITE DENIED" in p.screen and "READY" in p.screen, "denied")
        assert not (root / "approved.txt").exists()
        checks.append("default deny + paste does not approve + no write")
        p.send("write\r")
        p.wait(lambda: "PERMISSION: WRITE" in p.screen, "allow dialog")
        p.send("\t")
        p.wait(lambda: "[ALLOW ONCE]" in p.screen, "explicit allow selection")
        p.send("\r")
        p.wait(lambda: "WRITE APPROVED" in p.screen and "READY" in p.screen, "approved")
        assert (root / "approved.txt").read_text() == "approved"
        checks.append("explicit allow reaches real runAgent authorization + fixture write")
        p.send("unsafe\r")
        p.wait(lambda: "SAFE TEXT" in p.screen and "READY" in p.screen, "terminal sanitization")
        assert "clipboard-fixture" not in p.raw
        checks.append("untrusted terminal output sanitized")
        p.send("wait\r")
        p.wait(lambda: "RUNNING" in p.screen, "pending run")
        p.send("\x03")
        p.wait(lambda: "READY" in p.screen and (root / "cancelled.txt").exists(), "cancel")
        checks.append("Ctrl+C cancels actual provider fixture")
        p.exit()
        checks.append("Ctrl+D exit + terminal restoration + canonical input")
    finally:
        p.close()
    sessions = list((root / "sessions").glob("*.json"))
    assert len(sessions) == 1
    session_id = json.loads(sessions[0].read_text())["id"]
    p = Probe(root, ["--resume", session_id])
    try:
        p.wait(lambda: session_id in p.screen and "READY" in p.screen, "resume startup")
        p.send("resume-check\r")
        p.wait(lambda: "RESUME CONTINUATION OK" in p.screen, "resumed model continuation")
        p.exit(key="\x03")
        checks.append("session resume retains continuation + idle Ctrl+C restoration")
    finally:
        p.close()
    for sig in [signal.SIGTERM, signal.SIGHUP, signal.SIGINT]:
        p = Probe(root)
        try:
            p.wait(lambda: "pty-fixture" in p.screen, "signal startup")
            p.exit(sig=sig)
            checks.append(f"{sig.name} terminal restoration + canonical input")
        finally:
            p.close()
print(json.dumps({"result": "M72_PTY_ACCEPTANCE_OK", "checks": checks, "count": len(checks), "live_provider_inference": False}, indent=2))
