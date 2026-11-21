#!/usr/bin/env python3
"""
Kimbo JS end-to-end smoke tests.

Loads the real unpacked extension into headless Chrome through CDP
(Extensions.loadUnpacked), seeds a ledger, exercises the popup and panel, then
injects the real collector stack into the React SPA and SSR fixtures.

The fixture server logs every request. The suite fails if the extension adds
an API request or if the cache-only bundle read re-fetches a chunk.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import pathlib
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.parse
import urllib.request
from typing import Any

import websockets

ROOT = pathlib.Path(__file__).resolve().parents[2]
CHROME = os.environ.get("KIMBO_CHROME", "google-chrome")
VENDOR = ROOT / "test" / "fixtures" / "vendor"


class Failure(Exception):
    pass


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.counter = 0
        self.events: list[dict[str, Any]] = []

    async def call(self, method: str, params: dict | None = None, timeout: float = 30.0) -> dict:
        self.counter += 1
        request_id = self.counter
        await self.ws.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        while True:
            raw = await asyncio.wait_for(self.ws.recv(), timeout=timeout)
            message = json.loads(raw)
            if message.get("id") == request_id:
                if "error" in message:
                    raise Failure(f"CDP {method}: {message['error']}")
                return message
            self.events.append(message)

    async def evaluate(self, expression: str, await_promise: bool = True, timeout: float = 30.0):
        response = await self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": await_promise,
                "userGesture": True,
            },
            timeout=timeout,
        )
        result = response.get("result", {})
        if "exceptionDetails" in result:
            details = result["exceptionDetails"]
            text = details.get("exception", {}).get("description") or details.get("text") or "eval failed"
            raise Failure(f"Runtime.evaluate: {text[:1200]}")
        return result.get("result", {}).get("value")

    async def wait_for(self, expression: str, timeout: float = 12.0, interval: float = 0.15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                if await self.evaluate(expression, await_promise=False):
                    return True
            except Failure:
                pass
            await asyncio.sleep(interval)
        return False

    def exceptions(self) -> list[str]:
        out = []
        for event in self.events:
            if event.get("method") == "Runtime.exceptionThrown":
                details = event.get("params", {}).get("exceptionDetails", {})
                text = (
                    (details.get("exception") or {}).get("description")
                    or details.get("text")
                    or "exception"
                )
                out.append(str(text)[:500])
        return out


class Runner:
    def __init__(self):
        self.passed = 0
        self.failed = 0

    def check(self, name: str, condition: bool, detail: str = "") -> None:
        if condition:
            self.passed += 1
            print("PASS " + name, flush=True)
        else:
            self.failed += 1
            print("FAIL " + name + ((" :: " + detail) if detail else ""), flush=True)

    def equal(self, name: str, actual: Any, expected: Any) -> None:
        self.check(name, actual == expected, f"expected {expected!r}, got {actual!r}")

    def summary(self) -> int:
        print(f"SUMMARY e2e passed={self.passed} failed={self.failed}", flush=True)
        return 1 if self.failed else 0


def free_port() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def http_json(url: str, method: str = "GET") -> Any:
    request = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_http(url: str, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                response.read(64)
                return
        except Exception:
            time.sleep(0.15)
    raise Failure(f"HTTP endpoint did not become ready: {url}")


def start_fixture_server() -> tuple[subprocess.Popen, int, pathlib.Path]:
    port = free_port()
    log_path = pathlib.Path(tempfile.mkdtemp(prefix="kimbo-fixture-log.")) / "requests.log"
    process = subprocess.Popen(
        [
            sys.executable,
            "-I",
            str(ROOT / "test" / "fixtures" / "server.py"),
            "--port",
            str(port),
            "--log-file",
            str(log_path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    ready = False
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        if process.poll() is not None:
            output = process.stdout.read() if process.stdout else ""
            raise Failure("fixture server exited:\n" + output)
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/index.html", timeout=0.5) as response:
                response.read(32)
                ready = True
                break
        except Exception:
            time.sleep(0.12)
    if not ready:
        process.terminate()
        raise Failure("fixture server did not start")
    return process, port, log_path


def launch_chrome(port: int, profile: pathlib.Path, output_path: pathlib.Path) -> subprocess.Popen:
    output = output_path.open("w", encoding="utf-8")
    process = subprocess.Popen(
        [
            CHROME,
            "--headless=new",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-gpu",
            "--disable-background-networking",
            f"--remote-debugging-port={port}",
            "--enable-unsafe-extension-debugging",
            f"--user-data-dir={profile}",
            "about:blank",
        ],
        stdout=output,
        stderr=subprocess.STDOUT,
        text=True,
    )
    process.kimbo_output = output  # keep the log handle alive for the child
    wait_http(f"http://127.0.0.1:{port}/json/version", timeout=25)
    return process


async def load_extension(port: int) -> str:
    version = http_json(f"http://127.0.0.1:{port}/json/version")
    ws_url = version["webSocketDebuggerUrl"]
    async with websockets.connect(ws_url, max_size=50_000_000) as ws:
        client = CDP(ws)
        response = await client.call(
            "Extensions.loadUnpacked",
            {"path": str(ROOT)},
            timeout=20,
        )
        extension_id = response.get("result", {}).get("id")
        if not extension_id:
            raise Failure("Extensions.loadUnpacked returned no id")
        return extension_id


async def find_target(port: int, predicate, timeout: float = 12.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            targets = http_json(f"http://127.0.0.1:{port}/json")
        except Exception:
            targets = []
        for target in targets:
            if predicate(target):
                return target
        await asyncio.sleep(0.2)
    return None


async def ensure_service_worker(port: int, extension_id: str, timeout: float = 12.0):
    target = await find_target(
        port,
        lambda t: t.get("type") == "service_worker"
        and t.get("url", "").endswith("/src/background/service-worker.js")
        and extension_id in t.get("url", ""),
        timeout=timeout,
    )
    if target:
        return target
    # Wake the service worker by opening an extension page.
    url = f"chrome-extension://{extension_id}/src/ui/popup.html"
    try:
        http_json(f"http://127.0.0.1:{port}/json/new?{urllib.parse.quote(url, safe='')}", method="PUT")
    except Exception:
        pass
    return await find_target(
        port,
        lambda t: t.get("type") == "service_worker"
        and t.get("url", "").endswith("/src/background/service-worker.js")
        and extension_id in t.get("url", ""),
        timeout=timeout,
    )


async def open_page(port: int, url: str) -> tuple[CDP, dict, Any]:
    target = http_json(
        f"http://127.0.0.1:{port}/json/new?{urllib.parse.quote(url, safe='')}",
        method="PUT",
    )
    ws = await websockets.connect(target["webSocketDebuggerUrl"], max_size=80_000_000)
    client = CDP(ws)
    await client.call("Runtime.enable")
    await client.call("Page.enable")
    return client, target, ws


async def compile_source(client: CDP) -> tuple[int, list[str]]:
    errors = []
    files = sorted((ROOT / "src").rglob("*.js"))
    for path in files:
        text = path.read_text(encoding="utf-8")
        try:
            response = await client.call(
                "Runtime.compileScript",
                {
                    "expression": text,
                    "sourceURL": str(path),
                    "persistScript": False,
                },
            )
            if "exceptionDetails" in response.get("result", {}):
                details = response["result"]["exceptionDetails"]
                text_error = (
                    (details.get("exception") or {}).get("description")
                    or details.get("text")
                    or "compile error"
                )
                errors.append(f"{path.relative_to(ROOT)}: {text_error.splitlines()[0]}")
        except Failure as error:
            errors.append(f"{path.relative_to(ROOT)}: {error}")
    return len(files), errors


def read_log(path: pathlib.Path) -> list[str]:
    try:
        return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    except FileNotFoundError:
        return []


def api_lines(lines: list[str]) -> list[str]:
    return [line for line in lines if line.startswith("REQ ")]


def static_count(lines: list[str], path: str) -> int:
    return sum(1 for line in lines if line == f"STATIC GET {path}")


SEED_JS = r"""
(async (origin) => {
  const P = KimboCore.pipeline;
  const now = Date.now();
  const s = P.createSession(origin, { scope: { mode: 'site' } });
  const claims = [
    { key: 'sub', value: 'user-91', claim: 'sub' },
    { key: 'org_id', value: '482', claim: 'org_id' },
    { key: 'tenant_id', value: 'acme', claim: 'tenant_id' }
  ];
  const events = [
    { kind:'network', url: origin + '/api/v1/orgs/482/projects/91/members?role=admin', method:'GET', status:200, source:'fetch', pageUrl: origin + '/app/projects/91', ts: now, authClaims: claims, contentType:'application/json' },
    { kind:'network', url: origin + '/api/v1/orgs/482/projects/91', method:'PATCH', status:200, source:'fetch', pageUrl: origin + '/app/projects/91', ts: now - 1000, authClaims: claims, contentType:'application/json' },
    { kind:'network', url: origin + '/api/v1/orgs/482/members/17', method:'DELETE', status:204, source:'xhr', pageUrl: origin + '/app/members', ts: now - 2000, authClaims: claims },
    { kind:'network', url: origin + '/api/v1/users/91/profile', method:'GET', status:200, source:'fetch', pageUrl: origin + '/app/profile', ts: now - 3000, authClaims: claims },
    { kind:'network', url: origin + '/api/v1/orgs/482/invites', method:'POST', status:201, source:'fetch', pageUrl: origin + '/app/team', ts: now - 4000, authClaims: claims, bodyFields:[{key:'user_id', value:'91', path:'user_id'}] },
    { kind:'network', url: origin + '/api/v1/orgs/482/billing/invoices/INV-2026-0042', method:'GET', status:200, source:'fetch', pageUrl: origin + '/app/billing', ts: now - 5000, authClaims: claims },
    { kind:'network', url: origin + '/graphql', method:'POST', status:200, source:'fetch', pageUrl: origin + '/app/graphql', ts: now - 6000, authClaims: claims, contentType:'application/json' },
    { kind:'storage', entries:[
      {area:'localStorage', key:'current_org_id', path:['current_org_id'], value:'482'},
      {area:'localStorage', key:'current_user_id', path:['current_user_id'], value:'91'},
      {area:'localStorage', key:'tenant_id', path:['tenant_id'], value:'acme'},
      {area:'localStorage', key:'project_id', path:['project_id'], value:'91'},
      {area:'localStorage', key:'member_id', path:['member_id'], value:'17'},
      {area:'localStorage', key:'session_token', path:['session_token'], value:'SECRET_SESSION_TOKEN'}
    ], pageUrl: origin + '/app', ts: now },
    { kind:'dom', candidates:[{raw:'/api/v1/orgs/482/export', method:'POST', source:{kind:'form', label:'<form action>'}}], context:[{key:'org_id', value:'482', source:{kind:'dom', label:'<div data-org-id>'}}], pageUrl: origin + '/app', ts: now },
    { kind:'chunk', url: origin + '/assets/chunk-a.js', initiatorType:'script', pageUrl: origin + '/app', ts: now },
    { kind:'bundle', url: origin + '/assets/chunk-a.js', status:'analyzed', urls:[origin + '/api/v1/orgs/482/reports/77','/api/v1/feature-flags'], bytes:12345, count:2, trigger:'auto', via:'cache-storage', pageUrl: origin + '/app', ts: now }
  ];
  P.ingest(s, events, { origin: origin, scope: { mode: 'site' } });
  await chrome.storage.local.set({ ['kimbo:session:' + origin]: s });
  return { stats: s.stats, leaked: JSON.stringify(s).includes('SECRET_SESSION_TOKEN') };
})(ORIGIN)
"""


SPA_SUMMARY_JS = r"""
(() => {
  const ev = window.__KIMBO_TEST_SINK__ || [];
  const net = ev.filter((e) => e.kind === 'network');
  const dom = ev.filter((e) => e.kind === 'dom');
  const script = ev.filter((e) => e.kind === 'script');
  const bundle = ev.filter((e) => e.kind === 'bundle');
  const chunk = ev.filter((e) => e.kind === 'chunk');
  const page = ev.filter((e) => e.kind === 'page');
  const serialized = JSON.stringify(ev);
  let probe = [];
  try {
    probe = window.KimboStorageProbe ? window.KimboStorageProbe().map((x) => x.area + ':' + x.key + '=' + x.value) : [];
  } catch (error) {
    probe = ['ERR ' + error.message];
  }
  return {
    total: ev.length,
    counts: { net: net.length, dom: dom.length, script: script.length, bundle: bundle.length, chunk: chunk.length, page: page.length },
    methods: Array.from(new Set(net.map((e) => e.method).filter(Boolean))),
    netUrls: net.map((e) => e.url),
    claims: Array.from(new Set(net.flatMap((e) => (e.authClaims || []).map((c) => c.key + '=' + c.value)))),
    leakedJwt: Boolean(window.__testJwt && serialized.includes(window.__testJwt)),
    leakedSecrets: serialized.includes('FIXTURE_CSRF_SECRET') || serialized.includes('FIXTURE_PASSWORD') || serialized.includes('SECRET_SESSION_TOKEN'),
    domCandidates: dom.flatMap((e) => (e.candidates || []).map((c) => c.raw)),
    domContext: dom.flatMap((e) => (e.context || []).map((c) => c.key + '=' + c.value)),
    scriptUrls: script.flatMap((e) => e.urls || []),
    bundle: bundle.map((e) => ({ url: e.url, status: e.status, count: e.count, error: e.error })),
    chunks: chunk.map((e) => e.url),
    pages: page.map((e) => e.url),
    probe,
    chunkLoaded: Boolean(window.__chunkLoaded)
  };
})()
"""


SSR_SUMMARY_JS = r"""
(() => {
  const ev = window.__KIMBO_TEST_SINK__ || [];
  const net = ev.filter((e) => e.kind === 'network');
  const dom = ev.filter((e) => e.kind === 'dom');
  const script = ev.filter((e) => e.kind === 'script');
  return {
    total: ev.length,
    methods: Array.from(new Set(net.map((e) => e.method).filter(Boolean))),
    netUrls: net.map((e) => e.url),
    domCandidates: dom.flatMap((e) => (e.candidates || []).map((c) => c.raw)),
    domContext: dom.flatMap((e) => (e.context || []).map((c) => c.key + '=' + c.value)),
    scriptUrls: script.flatMap((e) => e.urls || []),
    pageCount: ev.filter((e) => e.kind === 'page').length
  };
})()
"""


async def run() -> int:
    runner = Runner()
    fixture, fixture_port, fixture_log = start_fixture_server()
    base = f"http://127.0.0.1:{fixture_port}"
    chrome_port = free_port()
    temp = pathlib.Path(tempfile.mkdtemp(prefix="kimbo-e2e."))
    chrome_log = temp / "chrome.log"
    chrome = None
    open_websockets = []
    try:
        chrome = launch_chrome(chrome_port, temp / "profile", chrome_log)
        extension_id = await load_extension(chrome_port)
        runner.check("extension: loaded via CDP", bool(extension_id), extension_id)

        # Compile every source file as a classic script.
        about_client, about_target, about_ws = await open_page(chrome_port, "about:blank")
        open_websockets.append(about_ws)
        total_files, compile_errors = await compile_source(about_client)
        runner.equal("extension: all source JS compiles", compile_errors, [])
        runner.check("extension: source files compiled", total_files > 20, str(total_files))

        sw_target = await ensure_service_worker(chrome_port, extension_id)
        runner.check("extension: service worker target exists", sw_target is not None)
        if not sw_target:
            raise Failure("service worker did not start")

        sw_ws = await websockets.connect(sw_target["webSocketDebuggerUrl"], max_size=50_000_000)
        open_websockets.append(sw_ws)
        sw = CDP(sw_ws)
        await sw.call("Runtime.enable")
        sw_info = await sw.evaluate(
            "(() => ({ manifest: chrome.runtime.getManifest().name, core: typeof KimboCore, bg: typeof KimboBG, probe: typeof KimboStorageProbe }))()",
            await_promise=False,
        )
        runner.equal("sw: manifest name", sw_info.get("manifest"), "Kimbo JS")
        runner.equal("sw: core loaded", sw_info.get("core"), "object")
        runner.equal("sw: background modules loaded", sw_info.get("bg"), "object")
        runner.equal("sw: storage probe available", sw_info.get("probe"), "function")

        # Seed a rich ledger for UI tests.
        seed = await sw.evaluate(SEED_JS.replace("ORIGIN", json.dumps(base)))
        runner.check("ui: seeded session has endpoints", seed.get("stats", {}).get("endpoints", 0) >= 8, json.dumps(seed.get("stats")))
        runner.check("ui: seeded session did not store its token", not seed.get("leaked"))

        # Popup.
        popup_url = f"chrome-extension://{extension_id}/src/ui/popup.html?origin={urllib.parse.quote(base, safe='')}&tabId=1"
        popup, popup_target, popup_ws = await open_page(chrome_port, popup_url)
        open_websockets.append(popup_ws)
        ready = await popup.wait_for("!!document.querySelector('.app .topbar')", timeout=15)
        runner.check("popup: shell rendered", ready)
        await popup.wait_for(
            "!!document.querySelector('.scope-gate') || document.querySelectorAll('.endpoint-card').length > 0",
            timeout=10,
        )
        clicked = await popup.evaluate(
            "(() => { const b=[...document.querySelectorAll('button')].find(x=>/View last snapshot/i.test(x.textContent)); if(!b) return false; b.click(); return true; })()",
            await_promise=False,
        )
        runner.check("popup: snapshot gate offers last capture", clicked)
        cards_ready = await popup.wait_for("document.querySelectorAll('.endpoint-card').length >= 8", timeout=10)
        runner.check("popup: endpoint cards rendered", cards_ready)
        card_count = await popup.evaluate("document.querySelectorAll('.endpoint-card').length", await_promise=False)
        runner.check("popup: enough cards", card_count >= 8, str(card_count))
        await popup.evaluate("document.querySelector('.endpoint-card')?.click()", await_promise=False)
        detail_ready = await popup.wait_for("/PREPARED FOR MANUAL TESTING/i.test(document.body.innerText)", timeout=8)
        runner.check("popup: detail view renders", detail_ready)
        detail_text = await popup.evaluate("document.body.innerText", await_promise=False)
        runner.check("popup: detail includes identity fills", "IDENTITY FILLS" in detail_text)
        runner.check("popup: detail includes manual test cards", "MANUAL TEST CARDS" in detail_text)
        runner.check("popup: no runtime exceptions", not popup.exceptions(), "; ".join(popup.exceptions()))

        # Panel (query-param mode works outside real DevTools for tests).
        panel_url = f"chrome-extension://{extension_id}/src/ui/panel.html?origin={urllib.parse.quote(base, safe='')}&tabId=1"
        panel, panel_target, panel_ws = await open_page(chrome_port, panel_url)
        open_websockets.append(panel_ws)
        await panel.wait_for("!!document.querySelector('.app .topbar')", timeout=15)
        await panel.wait_for(
            "!!document.querySelector('.scope-gate') || !!document.querySelector('.panel-split')",
            timeout=12,
        )
        panel_clicked = await panel.evaluate(
            "(() => { const b=[...document.querySelectorAll('button')].find(x=>/View last snapshot/i.test(x.textContent)); if(!b) return false; b.click(); return true; })()",
            await_promise=False,
        )
        runner.check("panel: snapshot gate offers last capture", panel_clicked)
        split_ready = await panel.wait_for("!!document.querySelector('.panel-split')", timeout=12)
        runner.check("panel: master-detail layout renders", split_ready)
        await panel.evaluate(
            "(() => { const b=[...document.querySelectorAll('.tab')].find(x=>/Lattice/i.test(x.textContent)); if(b)b.click(); return !!b; })()",
            await_promise=False,
        )
        lattice_ready = await panel.wait_for("document.querySelectorAll('.lattice-svg .node').length > 0", timeout=8)
        runner.check("panel: identity lattice renders", lattice_ready)
        await panel.evaluate(
            "(() => { const b=[...document.querySelectorAll('.tab')].find(x=>/Context/i.test(x.textContent)); if(b)b.click(); return !!b; })()",
            await_promise=False,
        )
        context_ready = await panel.wait_for("document.querySelectorAll('.anchor-row').length > 0", timeout=8)
        runner.check("panel: context anchors render", context_ready)
        runner.check("panel: no runtime exceptions", not panel.exceptions(), "; ".join(panel.exceptions()))

        # Collector stack against the React SPA.
        collector_scripts = [
            "src/core/constants.js",
            "src/core/normalizer.js",
            "src/collectors/bus.js",
            "src/collectors/network-hook.js",
            "src/collectors/dom-collector.js",
            "src/collectors/script-collector.js",
            "src/collectors/lifecycle.js",
            "src/collectors/storage-probe.js",
        ]
        combined = "window.__KIMBO_TEST_SINK__=[];\n" + "\n;\n".join(
            (ROOT / path).read_text(encoding="utf-8") for path in collector_scripts
        )
        spa, spa_target, spa_ws = await open_page(chrome_port, "about:blank")
        open_websockets.append(spa_ws)
        await spa.call("Page.addScriptToEvaluateOnNewDocument", {"source": combined})
        await spa.call("Page.navigate", {"url": base + "/spa.html"})
        loaded = await spa.wait_for("document.readyState === 'complete'", timeout=20)
        runner.check("spa: fixture loaded", loaded)
        await asyncio.sleep(5.2)
        summary = await spa.evaluate(SPA_SUMMARY_JS)
        runner.check("spa: collectors emitted events", summary.get("total", 0) >= 15, str(summary.get("counts")))
        methods = set(summary.get("methods", []))
        runner.check("spa: GET/PATCH/DELETE/POST observed", {"GET", "PATCH", "DELETE", "POST"}.issubset(methods), str(methods))
        urls = "\n".join(summary.get("netUrls", []))
        for needle in [
            "/api/v1/orgs/482/projects/91/members",
            "/api/v1/users/91/profile",
            "/api/v1/orgs/482/invites",
            "/graphql"
        ]:
            runner.check("spa: network capture " + needle, needle in urls)
        claims = set(summary.get("claims", []))
        runner.check("spa: JWT claims sub/org/tenant", {"sub=user-91", "org_id=482", "tenant_id=acme"}.issubset(claims), str(claims))
        runner.check("spa: raw JWT never crosses the bridge", not summary.get("leakedJwt"))
        runner.check("spa: CSRF/password secrets not collected", not summary.get("leakedSecrets"))
        dom_candidates = "\n".join(summary.get("domCandidates", []))
        for needle in [
            "/api/v1/orgs/482/billing",
            "/api/v1/orgs/482/export",
            "/api/v1/orgs/482/shadow/7"
        ]:
            runner.check("spa: DOM/shadow capture " + needle, needle in dom_candidates)
        dom_context = set(summary.get("domContext", []))
        runner.check("spa: DOM identity hints", {"org-id=482", "user-id=91"}.issubset(dom_context), str(dom_context))
        script_urls = "\n".join(summary.get("scriptUrls", []))
        runner.check("spa: inline/script route extraction", "/api/v1/orgs/482/reports/77" in script_urls and "/api/v1/feature-flags" in script_urls)
        chunks = "\n".join(summary.get("chunks", []))
        runner.check("spa: dynamic chunk detected", "/assets/chunk-a.js" in chunks)
        bundles = summary.get("bundle", [])
        chunk_bundle = next((b for b in bundles if "/assets/chunk-a.js" in (b.get("url") or "")), None)
        runner.check("spa: cached bundle analyzed", bool(chunk_bundle) and chunk_bundle.get("status") == "analyzed", json.dumps(chunk_bundle))
        runner.check("spa: cached bundle yielded routes", bool(chunk_bundle) and chunk_bundle.get("count", 0) >= 5, json.dumps(chunk_bundle))
        probe_values = "\n".join(summary.get("probe", []))
        runner.check("spa: storage probe reads org/user", "current_org_id=482" in probe_values and "current_user_id=91" in probe_values)
        runner.check("spa: storage probe skips secrets/PII", "FIXTURE" not in probe_values and "tester@example.test" not in probe_values)
        runner.check("spa: page lifecycle event", summary.get("counts", {}).get("page", 0) >= 1)
        runner.check("spa: no collector runtime exceptions", not spa.exceptions(), "; ".join(spa.exceptions()))

        await asyncio.sleep(0.5)
        log_after_spa = read_log(fixture_log)
        spa_api = api_lines(log_after_spa)
        runner.equal("network audit: SPA made exactly 7 API calls", len(spa_api), 7)
        runner.equal(
            "network audit: cache-only read did not re-fetch the chunk",
            static_count(log_after_spa, "/assets/chunk-a.js"),
            1,
        )

        # Collector stack against the SSR fixture.
        ssr, ssr_target, ssr_ws = await open_page(chrome_port, "about:blank")
        open_websockets.append(ssr_ws)
        await ssr.call("Page.addScriptToEvaluateOnNewDocument", {"source": combined})
        await ssr.call("Page.navigate", {"url": base + "/ssr.html"})
        await ssr.wait_for("document.readyState === 'complete'", timeout=20)
        await asyncio.sleep(2.4)
        ssr_summary = await ssr.evaluate(SSR_SUMMARY_JS)
        ssr_urls = "\n".join(ssr_summary.get("netUrls", []))
        runner.check("ssr: fetch observed", "/api/v1/orgs/482/ssr/99" in ssr_urls)
        runner.check("ssr: XHR observed", "/api/v1/orgs/482/ssr/actions" in ssr_urls)
        ssr_dom = "\n".join(ssr_summary.get("domCandidates", []))
        runner.check("ssr: form action captured", "/api/v1/orgs/482/export" in ssr_dom)
        runner.check("ssr: data-api URL captured", "/api/v1/users/91/profile" in ssr_dom)
        ssr_scripts = "\n".join(ssr_summary.get("scriptUrls", []))
        runner.check("ssr: inline template route captured", "/api/v1/orgs/${orgId}/members/${userId}" in ssr_scripts or "/api/v1/orgs/" in ssr_scripts)
        runner.check("ssr: page event", ssr_summary.get("pageCount", 0) >= 1)
        runner.check("ssr: no collector runtime exceptions", not ssr.exceptions(), "; ".join(ssr.exceptions()))

        await asyncio.sleep(0.5)
        log_final = read_log(fixture_log)
        final_api = api_lines(log_final)
        runner.equal("network audit: no extension-originated API requests", len(final_api), 9)
        runner.check(
            "network audit: no out-of-scope request",
            all("/evil" not in line for line in final_api),
        )

        # Close targets cleanly.
        for client_ws in open_websockets:
            try:
                await client_ws.close()
            except Exception:
                pass
        return runner.summary()
    except Exception:
        traceback.print_exc()
        print("SUMMARY e2e failed with exception", flush=True)
        return 1
    finally:
        try:
            if chrome and chrome.poll() is None:
                chrome.terminate()
                try:
                    chrome.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    chrome.kill()
        except Exception:
            pass
        try:
            fixture.terminate()
            fixture.wait(timeout=5)
        except Exception:
            try:
                fixture.kill()
            except Exception:
                pass
        print(f"INFO chrome_log={chrome_log}", flush=True)
        print(f"INFO fixture_log={fixture_log}", flush=True)


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
