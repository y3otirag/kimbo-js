#!/usr/bin/env python3
"""
Kimbo JS local fixtures.

Serves a real React SPA and an SSR page, plus fake API endpoints. API requests
are logged so tests can prove Kimbo did not call any discovered endpoint.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
LOG_LOCK = threading.Lock()
LOG_FILE: Path | None = None


def log_line(line: str) -> None:
    with LOG_LOCK:
        print(line, flush=True)
        if LOG_FILE:
            with LOG_FILE.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "KimboFixture/1.0"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        # Keep the console clean; explicit REQ lines are the test signal.
        return

    def _send(self, status: int, body: bytes = b"", content_type: str = "text/plain", extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        if extra:
            for key, value in extra.items():
                self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _api(self) -> None:
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        log_line(f"REQ {self.command} {parsed.path}")
        if parsed.path == "/graphql":
            payload = {"data": {"__typename": "Query", "org": {"id": 482}}}
            self._send(200, json.dumps(payload).encode(), "application/json", {"Cache-Control": "no-store"})
            return
        status = 204 if self.command == "DELETE" else 201 if self.command == "POST" else 200
        if status == 204:
            self._send(204, b"", "application/json", {"Cache-Control": "no-store"})
            return
        payload = {
            "ok": True,
            "method": self.command,
            "path": parsed.path,
            "query": parsed.query,
            "org_id": 482,
            "user_id": 91,
            "echo_bytes": len(body),
        }
        self._send(status, json.dumps(payload).encode(), "application/json", {"Cache-Control": "no-store"})

    def _static(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        log_line(f"STATIC {self.command} {path}")
        if path == "/":
            path = "/index.html"
        if path == "/favicon.ico":
            self._send(204, b"", "image/x-icon")
            return
        if path.startswith("/app/") or path == "/spa":
            path = "/spa.html"
        if path == "/ssr":
            path = "/ssr.html"
        relative = path.lstrip("/")
        target = (ROOT / relative).resolve()
        try:
            target.relative_to(ROOT)
        except ValueError:
            self._send(404, b"not found")
            return
        if not target.is_file():
            self._send(404, b"not found")
            return
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        data = target.read_bytes()
        extra: dict[str, str] = {}
        if path.startswith("/assets/") or path.startswith("/vendor/"):
            extra["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            extra["Cache-Control"] = "no-store"
        self._send(200, data, content_type, extra)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/") or parsed.path == "/graphql":
            self._api()
        else:
            self._static()

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
        self._api()

    def do_PUT(self) -> None:  # noqa: N802
        self._api()

    def do_PATCH(self) -> None:  # noqa: N802
        self._api()

    def do_DELETE(self) -> None:  # noqa: N802
        self._api()


def main() -> int:
    global LOG_FILE
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--log-file", default="")
    args = parser.parse_args()
    if args.log_file:
        LOG_FILE = Path(args.log_file).resolve()
        LOG_FILE.write_text("", encoding="utf-8")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    port = server.server_address[1]
    print(f"KIMBO_FIXTURE_PORT={port}", flush=True)
    log_line(f"READY http://{args.host}:{port}")

    def stop(*_args) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
