#!/usr/bin/env python3
"""
Kimbo JS test runner.

  1. manifest + source security audit
  2. core unit tests in headless Chrome
  3. end-to-end smoke tests against a real React SPA + SSR fixture

Usage:
  python3 -I test/run_tests.py
  python3 -I test/run_tests.py --skip-e2e
"""
from __future__ import annotations

import argparse
import html as html_module
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
CHROME = os.environ.get("KIMBO_CHROME", "google-chrome")

PASS_RE = re.compile(r"^PASS ", re.M)
FAIL_RE = re.compile(r"^FAIL ", re.M)


class Audit:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.details: list[str] = []

    def check(self, name: str, condition: bool, detail: str = "") -> None:
        if condition:
            self.passed += 1
            print("PASS audit: " + name, flush=True)
        else:
            self.failed += 1
            message = "FAIL audit: " + name + ((" :: " + detail) if detail else "")
            print(message, flush=True)
            self.details.append(message)


def source_files() -> list[pathlib.Path]:
    return sorted((ROOT / "src").rglob("*.js"))


def audit_manifest(audit: Audit) -> dict:
    try:
        manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    except Exception as error:
        audit.check("manifest parses", False, str(error))
        return {}
    audit.check("manifest parses", True)
    audit.check("manifest v3", manifest.get("manifest_version") == 3)
    audit.check("name", manifest.get("name") == "Kimbo JS")
    audit.check("description within Chrome limit", len(manifest.get("description", "")) <= 132)
    audit.check(
        "minimum permissions are exact",
        set(manifest.get("permissions", []))
        == {"storage", "scripting", "activeTab", "webNavigation"},
        str(manifest.get("permissions")),
    )
    audit.check("no broad host_permissions", "host_permissions" not in manifest)
    audit.check(
        "optional host permissions are explicit wildcards",
        set(manifest.get("optional_host_permissions", [])) == {"http://*/*", "https://*/*"},
        str(manifest.get("optional_host_permissions")),
    )
    audit.check("no static content_scripts", "content_scripts" not in manifest)
    audit.check("no web_accessible_resources", "web_accessible_resources" not in manifest)
    audit.check("incognito disabled", manifest.get("incognito") == "not_allowed")
    csp = (manifest.get("content_security_policy") or {}).get("extension_pages", "")
    audit.check("CSP restricts scripts to self", "script-src 'self'" in csp, csp)
    audit.check("CSP blocks objects", "object-src 'self'" in csp, csp)

    referenced = [
        manifest.get("background", {}).get("service_worker", ""),
        manifest.get("action", {}).get("default_popup", ""),
        manifest.get("devtools_page", ""),
    ]
    for size, path in manifest.get("icons", {}).items():
        referenced.append(path)
    for path in referenced:
        if path:
            audit.check(f"manifest asset exists: {path}", (ROOT / path).is_file())
    return manifest


def audit_sources(audit: Audit) -> None:
    files = source_files()
    audit.check("source files present", len(files) > 20, str(len(files)))
    all_text = "\n".join(path.read_text(encoding="utf-8") for path in files)

    fetch_files = sorted(
        str(path.relative_to(ROOT))
        for path in files
        if "fetch(" in path.read_text(encoding="utf-8")
    )
    audit.check(
        "fetch only exists in the hook and cache-only reader",
        fetch_files == ["src/collectors/network-hook.js", "src/collectors/script-collector.js"],
        str(fetch_files),
    )
    collector = (ROOT / "src/collectors/script-collector.js").read_text(encoding="utf-8")
    audit.check("cache-only fetch uses only-if-cached", "cache: 'only-if-cached'" in collector)
    audit.check("cache-only fetch is same-origin", "mode: 'same-origin'" in collector)
    audit.check("cache-only fetch rejects redirects", "redirect: 'error'" in collector)
    audit.check("no fetch in background/UI/core", not any(
        "fetch(" in (ROOT / path).read_text(encoding="utf-8")
        for path in [
            "src/background/service-worker.js",
            "src/background/session-store.js",
            "src/background/scope-manager.js",
            "src/ui/popup.js",
            "src/ui/panel.js",
            "src/ui/shared/api.js",
            "src/ui/shared/actions.js",
            "src/ui/shared/shell.js",
        ]
    ))
    audit.check("no XMLHttpRequest creation outside the passive hook", all(
        "new XMLHttpRequest" not in (ROOT / path).read_text(encoding="utf-8")
        for path in [
            "src/background/service-worker.js",
            "src/background/session-store.js",
            "src/background/scope-manager.js",
            "src/ui/popup.js",
            "src/ui/panel.js",
            "src/ui/shared/api.js",
            "src/ui/shared/actions.js",
            "src/ui/shared/shell.js",
        ]
    ))
    audit.check("no sendBeacon", "sendBeacon" not in all_text)
    audit.check("no WebSocket", "new WebSocket" not in all_text)
    audit.check("no EventSource", "new EventSource" not in all_text)
    audit.check("no chrome.debugger", "chrome.debugger" not in all_text)
    audit.check("no chrome.webRequest", "chrome.webRequest" not in all_text)
    audit.check("no chrome.storage.sync", "storage.sync" not in all_text)
    audit.check("no new Function", "new Function" not in all_text)
    audit.check("no innerHTML in extension source", "innerHTML" not in all_text)
    audit.check("no tab capture APIs", "tabCapture" not in all_text)
    audit.check("no remote code import", not re.search(r"importScripts\(\s*['\"]https?://", all_text))

    eval_lines = []
    for path in files:
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r"\beval\s*\(", line):
                eval_lines.append((path, line_no, line.strip()))
    unexpected = [
        item for item in eval_lines if "inspectedWindow.eval" not in item[2]
    ]
    audit.check(
        "no eval except the DevTools origin read",
        not unexpected,
        str(unexpected[:3]),
    )
    audit.check(
        "DevTools origin read is the only eval",
        all("inspectedWindow.eval" in item[2] for item in eval_lines),
        str(eval_lines[:3]),
    )

    scope_js = (ROOT / "src/background/scope-manager.js").read_text(encoding="utf-8")
    for file_path in re.findall(r"'(src/[^']+\.js)'", scope_js):
        audit.check(f"registered content script exists: {file_path}", (ROOT / file_path).is_file())

    for html_path in [
        ROOT / "src/ui/popup.html",
        ROOT / "src/ui/panel.html",
        ROOT / "src/devtools/devtools.html",
    ]:
        text = html_path.read_text(encoding="utf-8")
        audit.check(
            f"no remote scripts: {html_path.relative_to(ROOT)}",
            not re.search(r"<script[^>]+src=[\"']https?://", text, re.I),
        )
        for ref in re.findall(r"<script[^>]+src=[\"']([^\"']+)[\"']", text):
            target = (html_path.parent / ref).resolve()
            audit.check(
                f"local script exists: {html_path.relative_to(ROOT)} -> {ref}",
                target.is_file(),
            )
        for ref in re.findall(r"<link[^>]+href=[\"']([^\"']+)[\"']", text):
            if ref.startswith("http"):
                continue
            target = (html_path.parent / ref).resolve()
            audit.check(
                f"local style exists: {html_path.relative_to(ROOT)} -> {ref}",
                target.is_file(),
            )

    audit.check(
        "no plaintext token/cookie storage keys are persisted",
        not re.search(r"localStorage\.setItem\([^)]*(token|cookie|password)", all_text, re.I),
    )


def run_core_tests() -> tuple[int, int, str]:
    page = ROOT / "test" / "unit" / "core-tests.html"
    profile = pathlib.Path(tempfile.mkdtemp(prefix="kimbo-core-profile."))
    command = [
        CHROME,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        f"--user-data-dir={profile}",
        "--virtual-time-budget=8000",
        "--dump-dom",
        page.resolve().as_uri(),
    ]
    process = subprocess.run(command, capture_output=True, text=True, timeout=90)
    if process.returncode != 0 and not process.stdout:
        return 0, 1, process.stderr[-1000:]
    match = re.search(r'<pre id="results">(.*?)</pre>', process.stdout, re.S)
    if not match:
        return 0, 1, "no results block\n" + process.stdout[:1000] + process.stderr[-1000:]
    output = html_module.unescape(match.group(1))
    passed = len(PASS_RE.findall(output))
    failed = len(FAIL_RE.findall(output))
    return passed, failed, output


def run_e2e() -> tuple[int, int, str]:
    command = [sys.executable, "-I", str(ROOT / "test" / "e2e" / "smoke.py")]
    process = subprocess.run(command, capture_output=True, text=True, timeout=180)
    output = (process.stdout or "") + (process.stderr or "")
    passed = len(PASS_RE.findall(output))
    failed = len(FAIL_RE.findall(output))
    if process.returncode != 0 and failed == 0:
        failed = 1
    return passed, failed, output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-core", action="store_true")
    parser.add_argument("--skip-e2e", action="store_true")
    args = parser.parse_args()

    print("== Kimbo JS audit ==", flush=True)
    audit = Audit()
    audit_manifest(audit)
    audit_sources(audit)

    core_passed = core_failed = 0
    if not args.skip_core:
        print("\n== Kimbo JS core tests ==", flush=True)
        try:
            core_passed, core_failed, core_output = run_core_tests()
            print(core_output, flush=True)
        except Exception as error:
            print(f"FAIL core tests: {error}", flush=True)
            core_failed = 1

    e2e_passed = e2e_failed = 0
    if not args.skip_e2e:
        print("\n== Kimbo JS end-to-end ==", flush=True)
        try:
            e2e_passed, e2e_failed, e2e_output = run_e2e()
            print(e2e_output, flush=True)
        except Exception as error:
            print(f"FAIL e2e: {error}", flush=True)
            e2e_failed = 1

    total_passed = audit.passed + core_passed + e2e_passed
    total_failed = audit.failed + core_failed + e2e_failed
    print("\n== TOTAL ==", flush=True)
    print(f"passed={total_passed} failed={total_failed}", flush=True)
    if audit.failed:
        print("\nAudit failures:", flush=True)
        for detail in audit.details:
            print(detail, flush=True)
    return 0 if total_failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
