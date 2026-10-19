#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Tab-scale baseline for the built Nightly.app (PRODUCT_DIRECTIONS B4 step 1).

One command:

    python3 tools/perf/tab-baseline/run.py

For every tab count (default 30, 60, 120) and run (default 2) it starts the
built browser with a fresh temporary profile and Marionette, opens N local
fixture tabs, and records RSS / footprint per process, time to open all tabs,
tab-switch latency, tab-strip scroll smoothness, unloaded tab counts and the
cold session-restore start. Results go to results/<timestamp>/ as runs.json,
summary.csv and report.md. Python 3.9+ standard library only; no network.
"""

import argparse
import csv
import datetime
import gzip
import html
import http.server
import json
import os
import random
import shutil
import signal
import socket
import statistics
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
DEFAULT_APP = REPO / "engine/obj-aarch64-apple-darwin/dist/Nightly.app"
CHROME_LIB = (HERE / "chrome.js").read_text()

SITES = 40
KINDS = ("text", "images", "app")
IMAGES_PER_PAGE = 8
IMAGE_SIZE = (640, 480)


# --------------------------------------------------------------------------
# Fixture server


def fixture_urls(count, port):
    """Three consecutive tabs per site (text, images, app); 120 tabs = 40 sites."""
    urls = []
    for i in range(count):
        site = (i // len(KINDS)) % SITES + 1
        urls.append(f"http://site{site:02d}.test:{port}/{KINDS[i % len(KINDS)]}.html?tab={i}")
    return urls


def make_png(seed, width, height):
    rng = random.Random(seed)
    row_bytes = width * 3
    raw = bytearray()
    for _ in range(height):
        raw.append(0)
        raw += rng.getrandbits(8 * row_bytes).to_bytes(row_bytes, "little")

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 1))
        + chunk(b"IEND", b"")
    )


LOREM = (
    "Tab scale fixture text. The quick brown fox jumps over the lazy dog while the "
    "browser keeps many documents alive in background tabs. Sentences repeat to give "
    "the layout engine a realistic amount of text to shape, wrap and paint. "
)


class FixtureHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    templates = {}
    png_cache = {}
    png_lock = threading.Lock()

    def log_message(self, *args):
        pass

    def _send(self, status, ctype, body, cache):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        host = self.headers.get("Host", "site01.test").split(":")[0]
        site = host.split(".")[0]
        try:
            site_no = int(site.replace("site", "") or 1)
        except ValueError:
            site_no = 1
        path = self.path.split("?")[0]
        if path.startswith("/img/") and path.endswith(".png"):
            key = path[5:-4]
            with self.png_lock:
                body = self.png_cache.get(key)
                if body is None:
                    body = make_png(key, *IMAGE_SIZE)
                    self.png_cache[key] = body
            self._send(200, "image/png", body, "max-age=3600")
            return
        name = path.strip("/")
        kind = name[:-5] if name.endswith(".html") else ""
        if kind not in self.templates:
            self._send(404, "text/plain", b"not found", "no-store")
            return
        page = self.templates[kind]
        page = page.replace("{{SITE}}", html.escape(site)).replace("{{SEED}}", str(site_no))
        page = page.replace(
            "{{PARAGRAPHS}}",
            "\n".join(f"<p>{i}. {LOREM * (3 + i % 5)}</p>" for i in range(150)),
        )
        page = page.replace(
            "{{IMAGES}}",
            "\n".join(
                f'<figure><img src="/img/{site}-{k}.png" width="{IMAGE_SIZE[0]}" '
                f'height="{IMAGE_SIZE[1]}" alt=""></figure>'
                for k in range(IMAGES_PER_PAGE)
            ),
        )
        self._send(200, "text/html; charset=utf-8", page.encode(), "no-cache")


def start_server():
    FixtureHandler.templates = {
        kind: (HERE / "fixtures" / f"{kind}.html").read_text() for kind in KINDS
    }
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# --------------------------------------------------------------------------
# Profile


def profile_prefs(marionette_port):
    """Network-quiet profile. Marionette's "recommended prefs" are disabled on
    purpose: they turn off tab unloading, the process priority manager and
    background main-thread priority, which would distort this benchmark."""
    hosts = ",".join(f"site{i:02d}.test" for i in range(1, SITES + 1))
    return {
        "marionette.port": marionette_port,
        "remote.prefs.recommended": False,
        "network.dns.localDomains": hosts,
        "network.proxy.type": 0,
        "dom.security.https_first": False,
        "dom.security.https_first_schemeless": False,
        "dom.security.https_only_mode": False,
        # Session restore on the second (cold) start.
        "browser.startup.page": 3,
        "browser.startup.homepage": "about:blank",
        "browser.newtabpage.enabled": False,
        "browser.newtab.preload": False,
        # First-run and nags.
        "zen.welcome-screen.seen": True,
        "zen.updates.show-update-notification": False,
        "browser.aboutwelcome.enabled": False,
        "browser.preonboarding.enabled": False,
        "browser.shell.checkDefaultBrowser": False,
        "browser.startup.homepage_override.mstone": "ignore",
        "browser.tabs.warnOnClose": False,
        "browser.tabs.warnOnCloseOtherTabs": False,
        "browser.tabs.warnOnOpen": False,
        "browser.warnOnQuit": False,
        "browser.warnOnQuitShortcut": False,
        "toolkit.startup.max_resumed_crashes": -1,
        # No outgoing traffic.
        "app.update.disabledForTesting": True,
        "app.update.auto": False,
        "app.normandy.enabled": False,
        "app.normandy.api_url": "",
        "browser.region.network.url": "",
        "browser.search.update": False,
        "browser.safebrowsing.malware.enabled": False,
        "browser.safebrowsing.phishing.enabled": False,
        "browser.safebrowsing.downloads.enabled": False,
        "browser.safebrowsing.blockedURIs.enabled": False,
        "browser.safebrowsing.update.enabled": False,
        "browser.topsites.contile.enabled": False,
        "browser.urlbar.suggest.searches": False,
        "browser.urlbar.merino.endpointURL": "",
        "browser.ml.enable": False,
        "browser.translations.enable": False,
        "browser.discovery.enabled": False,
        "browser.pagethumbnails.capturing_disabled": True,
        "datareporting.healthreport.uploadEnabled": False,
        "datareporting.policy.dataSubmissionEnabled": False,
        "datareporting.policy.dataSubmissionPolicyBypassNotification": True,
        "datareporting.usage.uploadEnabled": False,
        "toolkit.telemetry.reportingpolicy.firstRun": False,
        "toolkit.telemetry.enabled": False,
        "toolkit.telemetry.unified": False,
        "dom.push.connection.enabled": False,
        "extensions.update.enabled": False,
        "extensions.getAddons.cache.enabled": False,
        "extensions.systemAddon.update.enabled": False,
        "geo.provider.network.url": "",
        "media.gmp-manager.updateEnabled": False,
        "network.captive-portal-service.enabled": False,
        "network.connectivity-service.enabled": False,
        "network.dns.disablePrefetch": True,
        "network.prefetch-next": False,
        "network.http.speculative-parallel-limit": 0,
        "services.settings.server": "data:,#remote-settings-dummy/v1",
        "identity.fxaccounts.enabled": False,
        "security.certerrors.mitm.priming.enabled": False,
    }


def write_profile(path, prefs):
    path.mkdir(parents=True, exist_ok=True)
    with open(path / "user.js", "w") as f:
        for name, value in prefs.items():
            f.write(f"user_pref({json.dumps(name)}, {json.dumps(value)});\n")


# --------------------------------------------------------------------------
# Marionette (raw protocol, chrome context)


class MarionetteError(Exception):
    pass


class Marionette:
    def __init__(self, port, timeout):
        deadline = time.monotonic() + timeout
        while True:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise MarionetteError(f"Marionette did not listen on {port}")
                time.sleep(0.25)
        self.sock.settimeout(None)
        self.msg_id = 0
        hello = self._recv()
        if hello.get("applicationType") != "gecko":
            raise MarionetteError(f"unexpected handshake {hello}")

    def _recv_exact(self, n):
        buf = bytearray()
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise MarionetteError("connection closed")
            buf += chunk
        return bytes(buf)

    def _recv(self):
        length = b""
        while not length.endswith(b":"):
            length += self._recv_exact(1)
        return json.loads(self._recv_exact(int(length[:-1])))

    def command(self, name, params=None):
        self.msg_id += 1
        data = json.dumps([0, self.msg_id, name, params or {}]).encode()
        self.sock.sendall(str(len(data)).encode() + b":" + data)
        while True:
            msg = self._recv()
            if msg[0] == 1 and msg[1] == self.msg_id:
                break
        if msg[2]:
            raise MarionetteError(f"{name}: {msg[2]}")
        return msg[3]

    def chrome(self, expr, *args):
        """Evaluates `await <expr>` in chrome with chrome.js loaded; args as a[0..]."""
        script = (
            CHROME_LIB
            + "\nconst __done = arguments[arguments.length - 1];\n"
            + "const a = Array.from(arguments).slice(0, -1);\n"
            + f"(async () => await {expr})().then(v => __done({{ ok: true, v }}), "
            + "e => __done({ ok: false, error: String(e) + '\\n' + (e && e.stack) }));"
        )
        res = self.command("WebDriver:ExecuteAsyncScript", {"script": script, "args": list(args)})
        value = res["value"]
        if not value.get("ok"):
            raise MarionetteError(value.get("error"))
        return value.get("v")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# --------------------------------------------------------------------------
# Measurements


def loadavg():
    out = subprocess.run(["sysctl", "-n", "vm.loadavg"], capture_output=True, text=True).stdout
    return [float(x) for x in out.strip("{} \n").split()[:3]]


def ps_tree(root_pid):
    out = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,rss=,comm="], capture_output=True, text=True
    ).stdout
    rows = {}
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4:
            rows[int(parts[0])] = (int(parts[1]), int(parts[2]) * 1024, parts[3])
    tree, frontier = {}, [root_pid]
    while frontier:
        pid = frontier.pop()
        if pid in rows and pid not in tree:
            tree[pid] = rows[pid]
            frontier += [p for p, r in rows.items() if r[0] == pid]
    return tree


def snapshot(m, label):
    snap = m.chrome("TB.snapshot()")
    procs = snap["procs"]
    parent_pid = procs[0]["pid"]
    tree = ps_tree(parent_pid)
    known = {p["pid"] for p in procs}
    for p in procs:
        p["rss"] = tree.get(p["pid"], (0, 0, ""))[1]
    for pid, (_, rss, comm) in tree.items():
        if pid not in known:
            procs.append({"pid": pid, "type": "other:" + os.path.basename(comm), "origin": "",
                          "memory": 0, "rss": rss, "cpuTimeMs": 0, "threads": 0, "windows": 0})
    by_type = {}
    for p in procs:
        t = by_type.setdefault(p["type"], {"count": 0, "rssMB": 0.0, "footprintMB": 0.0})
        t["count"] += 1
        t["rssMB"] += p["rss"] / 2**20
        t["footprintMB"] += p["memory"] / 2**20
    snap.update(
        label=label,
        loadavg=loadavg(),
        parentPid=parent_pid,
        rssTotalMB=sum(p["rss"] for p in procs) / 2**20,
        footprintTotalMB=sum(p["memory"] for p in procs) / 2**20,
        processCount=len(procs),
        # Content processes in use; idle "preallocated" spares are excluded
        # (they are listed under byType).
        contentProcessCount=sum(1 for p in procs if p["type"] in
                                ("web", "webIsolated", "webServiceWorker", "withCoopCoep",
                                 "file", "extension", "privilegedabout", "privilegedmozilla",
                                 "inference")),
        byType=by_type,
    )
    print(f"    [{label}] tabs={snap['tabs']} rss={snap['rssTotalMB']:.0f}MB "
          f"footprint={snap['footprintTotalMB']:.0f}MB procs={len(procs)} load={snap['loadavg'][0]}",
          flush=True)
    return snap


def wait_for_load(max_load, max_wait):
    start = time.monotonic()
    while True:
        load = loadavg()
        if max_load <= 0 or load[0] <= max_load:
            return load, time.monotonic() - start
        if time.monotonic() - start > max_wait:
            print(f"  load {load[0]} still above {max_load} after {max_wait}s; continuing (flagged)")
            return load, time.monotonic() - start
        time.sleep(10)


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def app_binary(app):
    """Nightly.app, Firefox.app (vanilla comparison) or Zen.app main binary."""
    for name in ("nightly", "firefox", "zen"):
        path = Path(app) / "Contents/MacOS" / name
        if path.exists():
            return path
    return None


class Browser:
    def __init__(self, app, profile, port, log_path, timeout):
        binary = app_binary(app)
        env = dict(os.environ, MOZ_CRASHREPORTER_DISABLE="1")
        self.log = open(log_path, "ab")
        self.launched = time.monotonic()
        self.pid = None
        self.proc = subprocess.Popen(
            [str(binary), "-marionette", "-remote-allow-system-access", "-no-remote",
             "-foreground", "-profile", str(profile)],
            stdout=self.log, stderr=subprocess.STDOUT, env=env, start_new_session=True,
        )
        try:
            self.m = Marionette(port, timeout)
            self.m.command("WebDriver:NewSession", {"capabilities": {}})
            self.m.command("Marionette:SetContext", {"value": "chrome"})
            self.m.command("WebDriver:SetTimeouts", {"script": 900000})
        except BaseException:
            self.kill()
            self.log.close()
            raise

    def quit(self):
        try:
            self.pid = self.m.chrome("TB.procs()")[0]["pid"]
            self.m.command("Marionette:Quit", {"flags": ["eAttemptQuit"]})
        except (MarionetteError, OSError):
            pass
        self.m.close()
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if self.proc.poll() is not None and not (self.pid and pid_alive(self.pid)):
                break
            time.sleep(0.25)
        else:
            self.kill()
        self.log.close()

    def kill(self):
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except OSError:
            pass
        for pid in filter(None, [self.pid, self.proc.pid]):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass


def run_once(args, server_port, tabs, run_no, workdir):
    print(f"== {tabs} tabs, run {run_no}", flush=True)
    load_before, waited = wait_for_load(args.max_load, args.max_load_wait)
    mport = free_port()
    profile = workdir / f"profile-{tabs}-{run_no}"
    if profile.exists():
        shutil.rmtree(profile)
    write_profile(profile, {**profile_prefs(mport), **args.pref_overrides})
    log_path = workdir / f"browser-{tabs}-{run_no}.log"
    result = {"tabs": tabs, "run": run_no, "loadBefore": load_before, "loadWaitS": waited,
              "started": datetime.datetime.now().isoformat(timespec="seconds")}
    urls = fixture_urls(tabs, server_port)
    browser = Browser(args.app, profile, mport, log_path, args.startup_timeout)
    try:
        m = browser.m
        m.command("WebDriver:SetWindowRect", {"x": 0, "y": 25, "width": args.width, "height": args.height})
        result["environment"] = m.chrome("TB.environment()")
        time.sleep(args.warmup)
        result["startup"] = snapshot(m, "startup")
        if args.profile_open:
            m.chrome("TB.startParentProfiler()")
        if args.open_mode == "queued":
            result["open"] = m.chrome("TB.openTabsQueued(a[0], a[1], a[2])", urls,
                                      args.queue_size, args.open_timeout * 1000)
        else:
            result["open"] = m.chrome("TB.openTabs(a[0], a[1])", urls, args.open_timeout * 1000)
        if args.profile_open:
            raw = workdir / f"profile-open-{tabs}-{run_no}.json"
            m.chrome("TB.dumpParentProfile(a[0])", str(raw))
            outdir = Path(args.out_dir)
            outdir.mkdir(parents=True, exist_ok=True)
            with open(raw, "rb") as src, gzip.open(outdir / f"{raw.name}.gz", "wb") as dst:
                shutil.copyfileobj(src, dst)
            raw.unlink()
        o = result["open"]
        print(f"    open: create={o['createMs']:.0f}ms allLoaded={o['allLoadedMs']}ms "
              f"lagMax={o['parentLag'].get('max', 0):.0f}ms", flush=True)
        time.sleep(args.settle)
        result["loaded"] = snapshot(m, "loaded")
        rng = random.Random(1000 + tabs)
        indices = [rng.randrange(tabs) for _ in range(args.switches * 2)]
        dedup = [i for k, i in enumerate(indices) if k == 0 or indices[k - 1] != i][: args.switches]
        result["switch"] = m.chrome("TB.switchTabs(a[0], a[1])", dedup, args.switch_gap)
        s = result["switch"]
        print(f"    switch: n={s['switches']} layers median={s['layers'].get('median', 0):.1f} "
              f"p95={s['layers'].get('p95', 0):.1f}ms paint median={s['paint'].get('median', 0):.1f} "
              f"p95={s['paint'].get('p95', 0):.1f}ms", flush=True)
        result["scroll"] = m.chrome("TB.scrollTabStrip(a[0], a[1])", args.scroll_passes, args.scroll_step)
        sc = result["scroll"]
        print(f"    scroll: range={sc['scrollRangePx']}px frames={sc['frames'].get('n', 0)} "
              f"p95={sc['frames'].get('p95', 0):.1f}ms max={sc['frames'].get('max', 0):.1f}ms", flush=True)
        time.sleep(args.idle)
        result["idle"] = snapshot(m, "idle")
        if args.probe_unloader:
            result["unloaderProbe"] = m.chrome("TB.probeUnloader()")
            print(f"    unloader probe: {result['unloaderProbe']}", flush=True)
    finally:
        browser.quit()
    if args.restore:
        time.sleep(2)
        browser = Browser(args.app, profile, mport, log_path, args.startup_timeout)
        try:
            m = browser.m
            restored = m.chrome("TB.waitForSessionRestored(a[0])", 120000)
            result["restore"] = {"sessionRestoredSeen": restored, "startupInfo": m.chrome("TB.startupInfo()")}
            time.sleep(args.settle)
            result["restore"]["snapshot"] = snapshot(m, "restored")
            print(f"    restore: {result['restore']['startupInfo']}", flush=True)
        finally:
            browser.quit()
    result["loadAfter"] = loadavg()
    result["finished"] = datetime.datetime.now().isoformat(timespec="seconds")
    if not args.keep_profiles:
        shutil.rmtree(profile, ignore_errors=True)
    return result


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# --------------------------------------------------------------------------
# Output


def g(d, *path, default=None):
    for p in path:
        if not isinstance(d, dict) or p not in d:
            return default
        d = d[p]
    return d


COLUMNS = [
    ("tabs", lambda r: r["tabs"]),
    ("run", lambda r: r["run"]),
    ("load1_before", lambda r: r["loadBefore"][0]),
    ("load1_after", lambda r: r["loadAfter"][0]),
    ("open_mode", lambda r: g(r, "open", "mode")),
    ("open_create_ms", lambda r: g(r, "open", "createMs")),
    ("open_all_loaded_ms", lambda r: g(r, "open", "allLoadedMs")),
    ("open_parent_lag_max_ms", lambda r: g(r, "open", "parentLag", "max")),
    ("open_parent_lag_p95_ms", lambda r: g(r, "open", "parentLag", "p95")),
    ("open_parent_lag_over50", lambda r: g(r, "open", "parentLag", "over50")),
    ("open_parent_lag_over200", lambda r: g(r, "open", "parentLag", "over200")),
    ("loaded_rss_mb", lambda r: g(r, "loaded", "rssTotalMB")),
    ("loaded_footprint_mb", lambda r: g(r, "loaded", "footprintTotalMB")),
    ("loaded_processes", lambda r: g(r, "loaded", "processCount")),
    ("loaded_content_processes", lambda r: g(r, "loaded", "contentProcessCount")),
    ("loaded_parent_footprint_mb", lambda r: g(r, "loaded", "byType", "browser", "footprintMB")),
    ("loaded_gpu_footprint_mb", lambda r: g(r, "loaded", "byType", "gpu", "footprintMB")),
    ("switch_n", lambda r: g(r, "switch", "switches")),
    ("switch_layers_median_ms", lambda r: g(r, "switch", "layers", "median")),
    ("switch_layers_p95_ms", lambda r: g(r, "switch", "layers", "p95")),
    ("switch_layers_max_ms", lambda r: g(r, "switch", "layers", "max")),
    ("switch_paint_median_ms", lambda r: g(r, "switch", "paint", "median")),
    ("switch_paint_p95_ms", lambda r: g(r, "switch", "paint", "p95")),
    ("switch_over50_layers", lambda r: g(r, "switch", "over50Layers")),
    ("scroll_range_px", lambda r: g(r, "scroll", "scrollRangePx")),
    ("scroll_frames", lambda r: g(r, "scroll", "frames", "n")),
    ("scroll_frame_median_ms", lambda r: g(r, "scroll", "frames", "median")),
    ("scroll_frame_p95_ms", lambda r: g(r, "scroll", "frames", "p95")),
    ("scroll_frame_max_ms", lambda r: g(r, "scroll", "frames", "max")),
    ("scroll_frames_over50", lambda r: g(r, "scroll", "framesOver50")),
    ("idle_rss_mb", lambda r: g(r, "idle", "rssTotalMB")),
    ("idle_footprint_mb", lambda r: g(r, "idle", "footprintTotalMB")),
    ("idle_tabs_loaded", lambda r: g(r, "idle", "tabs", "loaded")),
    ("idle_tabs_unloaded", lambda r: (g(r, "idle", "tabs", "unloaded") or 0) + (g(r, "idle", "tabs", "pending") or 0)),
    ("unloader_probe_unloaded", lambda r: g(r, "unloaderProbe", "unloaded")),
    ("restore_first_paint_ms", lambda r: g(r, "restore", "startupInfo", "firstPaint2") or g(r, "restore", "startupInfo", "firstPaint")),
    ("restore_session_restored_ms", lambda r: g(r, "restore", "startupInfo", "sessionRestored")),
    # Excludes the OS launch before XRE main (dyld, page-in), which grows with machine load.
    ("restore_main_to_restored_ms", lambda r: (
        g(r, "restore", "startupInfo", "sessionRestored") - g(r, "restore", "startupInfo", "main")
        if g(r, "restore", "startupInfo", "sessionRestored") is not None else None)),
    ("restore_rss_mb", lambda r: g(r, "restore", "snapshot", "rssTotalMB")),
    ("restore_footprint_mb", lambda r: g(r, "restore", "snapshot", "footprintTotalMB")),
    ("restore_tabs_total", lambda r: g(r, "restore", "snapshot", "tabs", "total")),
    ("restore_tabs_pending", lambda r: (g(r, "restore", "snapshot", "tabs", "pending") or 0) + (g(r, "restore", "snapshot", "tabs", "unloaded") or 0)),
]


def fmt(v):
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:.1f}"
    return str(v)


def write_outputs(outdir, meta, results):
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "runs.json").write_text(json.dumps({"meta": meta, "runs": results}, indent=1))
    with open(outdir / "summary.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([c for c, _ in COLUMNS])
        for r in results:
            w.writerow([fmt(fn(r)) for _, fn in COLUMNS])
    lines = [
        "# Tab-scale baseline",
        "",
        f"- Generated: {meta['generated']}  ",
        f"- App: `{meta['app']}` ({meta.get('appVersion')}, build {meta.get('appBuildID')})  ",
        f"- Repo: {meta['gitHead']}{' (dirty)' if meta['gitDirty'] else ''}  ",
        f"- Machine: {meta['machine']}  ",
        f"- Command: `{meta['command']}`  ",
        f"- Open mode: {meta['args']['open_mode']}; pref overrides: "
        f"{json.dumps(meta['args']['pref_overrides']) if meta['args']['pref_overrides'] else 'none'}",
        "",
        "Per run (load = 1-min `vm.loadavg` before/after the run):",
        "",
    ]
    cols = [c for c, _ in COLUMNS]
    lines.append("| metric | " + " | ".join(f"{r['tabs']}×{r['run']}" for r in results) + " |")
    lines.append("|---|" + "---|" * len(results))
    for c, fn in COLUMNS[2:]:
        lines.append(f"| {c} | " + " | ".join(fmt(fn(r)) for r in results) + " |")
    lines += ["", "Run-to-run spread per tab count (|run max − run min| / mean):", ""]
    counts = sorted({r["tabs"] for r in results})
    lines.append("| metric | " + " | ".join(f"{n} tabs mean | spread" for n in counts) + " |")
    lines.append("|---|" + "---|---|" * len(counts))
    for c, fn in COLUMNS[2:]:
        row = []
        for n in counts:
            vals = [fn(r) for r in results if r["tabs"] == n]
            vals = [v for v in vals if isinstance(v, (int, float)) and not isinstance(v, bool)]
            if not vals:
                row += ["", ""]
                continue
            mean = statistics.mean(vals)
            spread = (max(vals) - min(vals)) / mean * 100 if mean else 0.0
            row += [f"{mean:.1f}", f"{spread:.0f}%"]
        lines.append(f"| {c} | " + " | ".join(row) + " |")
    (outdir / "report.md").write_text("\n".join(lines) + "\n")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--app", default=str(DEFAULT_APP))
    p.add_argument("--tabs", default="30,60,120", help="comma-separated tab counts")
    p.add_argument("--runs", type=int, default=2)
    p.add_argument("--out", default=None, help="output dir (default results/<timestamp>)")
    p.add_argument("--workdir", default=None, help="temp dir for profiles/logs (default: mkdtemp)")
    p.add_argument("--width", type=int, default=1440)
    p.add_argument("--height", type=int, default=900)
    p.add_argument("--warmup", type=float, default=5, help="seconds idle after startup")
    p.add_argument("--settle", type=float, default=10, help="seconds after load before RSS")
    p.add_argument("--idle", type=float, default=60, help="seconds idle before the idle RSS sample")
    p.add_argument("--switches", type=int, default=30)
    p.add_argument("--switch-gap", type=int, default=300, help="ms between tab switches")
    p.add_argument("--scroll-passes", type=int, default=2)
    p.add_argument("--scroll-step", type=int, default=40, help="px per frame")
    p.add_argument("--open-timeout", type=int, default=300, help="seconds")
    p.add_argument("--startup-timeout", type=int, default=90, help="seconds")
    p.add_argument("--max-load", type=float, default=0, help="wait until 1-min load <= this (0 = off)")
    p.add_argument("--max-load-wait", type=int, default=300)
    p.add_argument("--no-restore", dest="restore", action="store_false",
                   help="skip the cold session-restore start")
    p.add_argument("--probe-unloader", action="store_true",
                   help="after the idle sample, call TabUnloader once (changes tab state)")
    p.add_argument("--keep-profiles", action="store_true")
    p.add_argument("--open-mode", choices=("loadTabs", "queued"), default="loadTabs",
                   help="loadTabs = product bulk open; queued = experiment (lazy tabs, bounded loads)")
    p.add_argument("--queue-size", type=int, default=6, help="concurrent loads for --open-mode queued")
    p.add_argument("--pref", action="append", default=[], metavar="NAME=VALUE",
                   help="extra user pref for the experiment profile (JSON value or string)")
    p.add_argument("--profile-open", action="store_true",
                   help="save a Gecko profile of the parent process for the open phase")
    args = p.parse_args()
    args.pref_overrides = {}
    for item in args.pref:
        name, _, value = item.partition("=")
        try:
            args.pref_overrides[name] = json.loads(value)
        except ValueError:
            args.pref_overrides[name] = value

    app = Path(args.app)
    if not app_binary(app):
        sys.exit(f"no nightly/firefox/zen binary under {app}/Contents/MacOS")
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    outdir = Path(args.out) if args.out else HERE / "results" / stamp
    args.out_dir = str(outdir)
    workdir = Path(args.workdir) if args.workdir else Path(tempfile.mkdtemp(prefix="tab-baseline-"))
    workdir.mkdir(parents=True, exist_ok=True)

    git = lambda *a: subprocess.run(["git", *a], cwd=REPO, capture_output=True, text=True).stdout.strip()
    meta = {
        "generated": datetime.datetime.now().isoformat(timespec="seconds"),
        "app": str(app),
        "gitHead": git("log", "-1", "--format=%h %s"),
        "gitDirty": bool(git("status", "--porcelain", "--untracked-files=no")),
        "machine": " / ".join([
            subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip(),
            f"{int(subprocess.run(['sysctl', '-n', 'hw.memsize'], capture_output=True, text=True).stdout) // 2**30} GB",
            f"{os.cpu_count()} cpus",
            "macOS " + subprocess.run(["sw_vers", "-productVersion"], capture_output=True, text=True).stdout.strip(),
        ]),
        "command": " ".join([os.path.basename(sys.executable)] + sys.argv),
        "args": vars(args),
    }
    server = start_server()
    print(f"fixtures on 127.0.0.1:{server.server_port}; workdir {workdir}; out {outdir}", flush=True)
    results = []
    try:
        for tabs in [int(x) for x in args.tabs.split(",")]:
            for run_no in range(1, args.runs + 1):
                r = run_once(args, server.server_port, tabs, run_no, workdir)
                results.append(r)
                env = r.get("environment", {})
                meta.setdefault("appVersion", env.get("appVersion"))
                meta.setdefault("appBuildID", env.get("appBuildID"))
                write_outputs(outdir, meta, results)
    finally:
        server.shutdown()
        if not args.workdir and not args.keep_profiles:
            shutil.rmtree(workdir, ignore_errors=True)
    print(f"wrote {outdir}/report.md, summary.csv, runs.json")


if __name__ == "__main__":
    main()
