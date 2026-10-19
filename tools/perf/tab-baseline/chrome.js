/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Chrome-context helpers for tools/perf/tab-baseline/run.py.
// run.py prepends this file to every Marionette ExecuteAsyncScript call made
// in the "chrome" context, so `window` is the first browser window and every
// function here runs with system privileges in the parent process.

/* global ChromeUtils, Services, Ci, gBrowser, gZenWorkspaces, window */

const TB = {
  sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  },

  nextFrame() {
    return new Promise(resolve => window.requestAnimationFrame(resolve));
  },

  stats(values) {
    if (!values.length) {
      return { n: 0 };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const pick = q =>
      sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      n: sorted.length,
      min: sorted[0],
      median: pick(0.5),
      p95: pick(0.95),
      max: sorted[sorted.length - 1],
      mean: sum / sorted.length,
    };
  },

  // Measures parent main-thread event-loop lag with a 16 ms timer chain.
  // Every overshoot of the timer is a period in which the parent main thread
  // could not run a task, i.e. the browser UI (tab strip included) was stuck.
  startLagProbe() {
    const probe = { lags: [], running: true };
    let expected = ChromeUtils.now() + 16;
    const tick = () => {
      if (!probe.running) {
        return;
      }
      const now = ChromeUtils.now();
      probe.lags.push(Math.max(0, now - expected));
      expected = now + 16;
      window.setTimeout(tick, 16);
    };
    window.setTimeout(tick, 16);
    probe.stop = () => {
      probe.running = false;
      const s = TB.stats(probe.lags);
      s.over50 = probe.lags.filter(l => l > 50).length;
      s.over200 = probe.lags.filter(l => l > 200).length;
      return s;
    };
    return probe;
  },

  tabState(tab) {
    const browser = tab.linkedBrowser;
    if (tab.hasAttribute("pending")) {
      return "pending";
    }
    if (!tab.linkedPanel || !browser || !browser.isConnected) {
      return "unloaded";
    }
    if (tab.hasAttribute("discarded") || browser.hasAttribute("discarded")) {
      return "unloaded";
    }
    if (tab.hasAttribute("busy")) {
      return "busy";
    }
    return "loaded";
  },

  benchTabs() {
    return gBrowser.tabs.filter(t => t._tbUrl !== undefined);
  },

  tabCounts() {
    const counts = { total: gBrowser.tabs.length, loaded: 0, busy: 0, pending: 0, unloaded: 0 };
    counts.groups = gBrowser.tabGroups ? gBrowser.tabGroups.length : 0;
    for (const tab of gBrowser.tabs) {
      counts[TB.tabState(tab)]++;
    }
    return counts;
  },

  async environment() {
    const prefs = {};
    const names = [
      "browser.lowMemoryResponseMask",
      "browser.lowMemoryResponseOnWarn",
      "browser.lowMemoryPollingIntervalMS",
      "browser.tabs.unloadOnLowMemory",
      "browser.tabs.min_inactive_duration_before_unload",
      "browser.sessionstore.restore_on_demand",
      "browser.sessionstore.restore_tabs_lazily",
      "browser.startup.page",
      "dom.ipc.processCount",
      "dom.ipc.processCount.webIsolated",
      "fission.autostart",
      "remote.prefs.recommended",
      "zen.tab-unloader.enabled",
      "zen.tab-unloader.timeout-minutes",
      "zen.tab-unloader.unload-pinned",
      "zen.tabs.load-queue.enabled",
      "zen.tabs.load-queue.max-concurrent",
      "zen.tabs.auto-groups.enabled",
      "zen.workspaces.enabled",
      "zen.view.use-single-toolbar",
      "gfx.webrender.compositor",
    ];
    for (const name of names) {
      const type = Services.prefs.getPrefType(name);
      let value = null;
      if (type == Services.prefs.PREF_INT) {
        value = Services.prefs.getIntPref(name);
      } else if (type == Services.prefs.PREF_BOOL) {
        value = Services.prefs.getBoolPref(name);
      } else if (type == Services.prefs.PREF_STRING) {
        value = Services.prefs.getStringPref(name);
      }
      prefs[name] = {
        value,
        defined: type != Services.prefs.PREF_INVALID,
        userSet: Services.prefs.prefHasUserValue(name),
      };
    }
    // The timer unloader is a window module (ZenTabUnloader.mjs) that sets
    // window.gZenTabUnloader; re-importing it would only return the same
    // module instance.
    const zenTimerUnloaderModule =
      typeof window.gZenTabUnloader != "undefined" &&
      "chrome://browser/content/zen-components/ZenTabUnloader.mjs";
    return {
      appVersion: Services.appinfo.version,
      appBuildID: Services.appinfo.appBuildID,
      platformVersion: Services.appinfo.platformVersion,
      fissionEnabled: Services.appinfo.fissionAutostart,
      prefs,
      zenTimerUnloaderGlobal: typeof window.gZenTabUnloader != "undefined",
      zenTimerUnloaderModule,
      devicePixelRatio: window.devicePixelRatio,
      windowSize: [window.outerWidth, window.outerHeight],
    };
  },

  async procs() {
    const info = await ChromeUtils.requestProcInfo();
    const toEntry = p => ({
      pid: p.pid,
      type: p.type,
      origin: p.origin || "",
      memory: p.memory,
      cpuTimeMs: p.cpuTime / 1e6,
      threads: p.threads ? p.threads.length : 0,
      windows: p.windows ? p.windows.length : 0,
    });
    return [toEntry(info), ...info.children.map(toEntry)];
  },

  async snapshot() {
    return {
      at: ChromeUtils.now(),
      tabs: TB.tabCounts(),
      procs: await TB.procs(),
    };
  },

  // Gecko profiler limited to the parent process ("pid:<parent>" selects all
  // its threads and no content-process threads, so content processes cannot
  // evict the parent's samples from the shared buffer budget).
  async startParentProfiler() {
    Services.profiler.StartProfiler(1 << 25, 1, ["js", "stackwalk", "cpu"], [
      "pid:" + Services.appinfo.processID,
    ]);
    await TB.sleep(500);
  },

  async dumpParentProfile(path) {
    Services.profiler.Pause();
    await Services.profiler.dumpProfileToFileAsync(path);
    Services.profiler.StopProfiler();
  },

  // Opens `urls` the way "Open all in tabs" does (one gBrowser.loadTabs call,
  // all in the background) and waits until every new tab finished loading.
  async openTabs(urls, timeoutMs) {
    const before = new Set(gBrowser.tabs);
    const probe = TB.startLagProbe();
    const start = ChromeUtils.now();
    gBrowser.loadTabs(urls, {
      inBackground: true,
      replace: false,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    const created = ChromeUtils.now();
    // Zen inserts each new tab next to the selected one, so tab order is not
    // the order of `urls`; match tabs by URL instead.
    const tabs = gBrowser.tabs.filter(t => !before.has(t));
    tabs.forEach(t => (t._tbUrl = ""));
    const wanted = new Set(urls);
    let allLoaded = null;
    const deadline = start + timeoutMs;
    while (ChromeUtils.now() < deadline) {
      const specs = new Set();
      const done = tabs.every(t => {
        const b = t.linkedBrowser;
        const spec = b?.currentURI?.spec;
        specs.add(spec);
        // Queued (lazy) tabs already report their URL; wait for the load.
        return (
          !t.hasAttribute("busy") &&
          !t.hasAttribute("pending") &&
          wanted.has(spec) &&
          !b.webProgress?.isLoadingDocument
        );
      });
      if (done && specs.size == wanted.size) {
        allLoaded = ChromeUtils.now();
        break;
      }
      await TB.sleep(50);
    }
    const lag = probe.stop();
    return {
      requested: urls.length,
      created: tabs.length,
      createMs: created - start,
      allLoadedMs: allLoaded === null ? null : allLoaded - start,
      timedOut: allLoaded === null,
      notLoaded: tabs.filter(t => t.hasAttribute("busy")).length,
      parentLag: lag,
      mode: "loadTabs",
    };
  },

  // Experiment for the "limit concurrent loads on bulk open" candidate:
  // create every tab with a lazy (unbound) browser, then bind and load at most
  // `concurrency` tabs at a time, one bind per event-loop task, so the
  // synchronous content-process launch happens in many short tasks instead of
  // one long one. Not what the product does today.
  async openTabsQueued(urls, concurrency, timeoutMs) {
    const probe = TB.startLagProbe();
    const start = ChromeUtils.now();
    const principal = Services.scriptSecurityManager.getSystemPrincipal();
    const tabs = urls.map(url => {
      const tab = gBrowser.addTab(url, {
        createLazyBrowser: true,
        inBackground: true,
        skipAnimation: true,
        triggeringPrincipal: principal,
      });
      tab._tbUrl = "";
      tab._tbQueuedUrl = url;
      return tab;
    });
    const created = ChromeUtils.now();
    const queue = [...tabs];
    const active = new Set();
    const isDone = t => {
      const b = t.linkedBrowser;
      return (
        !t.hasAttribute("busy") &&
        b?.currentURI?.spec == t._tbQueuedUrl &&
        !b.webProgress?.isLoadingDocument
      );
    };
    let allLoaded = null;
    const deadline = start + timeoutMs;
    while (ChromeUtils.now() < deadline) {
      for (const t of active) {
        if (isDone(t)) {
          // Lazy tabs carry pending="true"; SessionStore clears it on
          // restore, so do the same once the manual load has finished.
          t.removeAttribute("pending");
          active.delete(t);
        }
      }
      while (active.size < concurrency && queue.length) {
        const tab = queue.shift();
        gBrowser.insertBrowser(tab);
        tab.linkedBrowser.fixupAndLoadURIString(tab._tbQueuedUrl, {
          triggeringPrincipal: principal,
        });
        active.add(tab);
        await TB.sleep(0);
      }
      if (!queue.length && !active.size) {
        allLoaded = ChromeUtils.now();
        break;
      }
      await TB.sleep(20);
    }
    const lag = probe.stop();
    return {
      requested: urls.length,
      created: tabs.length,
      createMs: created - start,
      allLoadedMs: allLoaded === null ? null : allLoaded - start,
      timedOut: allLoaded === null,
      notLoaded: queue.length + active.size,
      parentLag: lag,
      mode: `queued:${concurrency}`,
    };
  },

  // Talos-tabswitch-style measurement: time from `selectedTab = tab` until
  // the target browser's layers are ready (MozLayerTreeReady, `layersMs`),
  // plus the time until the first composited window paint after that
  // (`paintMs`, the frame that shows the new tab). TabSwitchDone is awaited
  // only so switches do not overlap; it fires after
  // browser.tabs.remote.unloadDelayMs and is not a latency signal.
  async switchTo(tab) {
    const browser = tab.linkedBrowser;
    const start = ChromeUtils.now();
    const switchDone = new Promise(resolve =>
      gBrowser.addEventListener("TabSwitchDone", resolve, { once: true })
    );
    const layersReady = new Promise(resolve => {
      if (browser.hasLayers) {
        resolve(ChromeUtils.now());
        return;
      }
      browser.addEventListener(
        "MozLayerTreeReady",
        () => resolve(ChromeUtils.now()),
        { once: true }
      );
    });
    gBrowser.selectedTab = tab;
    const layers = await Promise.race([layersReady, TB.sleep(5000).then(() => null)]);
    const paint =
      layers === null
        ? null
        : await Promise.race([
            new Promise(resolve =>
              window.addEventListener("MozAfterPaint", () => resolve(ChromeUtils.now()), {
                once: true,
              })
            ),
            TB.sleep(1000).then(() => null),
          ]);
    const done = await Promise.race([switchDone, TB.sleep(5000).then(() => "timeout")]);
    return {
      timedOut: done === "timeout" || layers === null,
      layersMs: layers === null ? null : layers - start,
      paintMs: paint === null ? null : paint - start,
      state: TB.tabState(tab),
    };
  },

  async switchTabs(indices, gapMs) {
    const tabs = TB.benchTabs();
    const samples = [];
    for (const i of indices) {
      const tab = tabs[i % tabs.length];
      if (tab.selected) {
        continue;
      }
      await TB.sleep(gapMs);
      const s = await TB.switchTo(tab);
      s.index = i;
      samples.push(s);
    }
    const layers = samples.filter(s => s.layersMs !== null).map(s => s.layersMs);
    const paints = samples.filter(s => s.paintMs !== null).map(s => s.paintMs);
    return {
      switches: samples.length,
      timeouts: samples.filter(s => s.timedOut).length,
      layers: TB.stats(layers),
      paint: TB.stats(paints),
      over50Layers: layers.filter(v => v > 50).length,
      samples,
    };
  },

  // Scrolls the active Zen vertical tab list top->bottom->top `passes` times,
  // one step per animation frame, and records the frame intervals.
  async scrollTabStrip(passes, stepPx) {
    const box =
      (typeof gZenWorkspaces != "undefined" && gZenWorkspaces.activeScrollbox) ||
      gBrowser.tabContainer.arrowScrollbox;
    const el = box.scrollbox || box;
    const range = el.scrollHeight - el.clientHeight;
    const probe = TB.startLagProbe();
    const frames = [];
    const start = ChromeUtils.now();
    if (range > 0) {
      el.scrollTop = 0;
      await TB.nextFrame();
      let last = ChromeUtils.now();
      for (let p = 0; p < passes; p++) {
        for (const dir of [1, -1]) {
          let y = dir > 0 ? 0 : range;
          while (dir > 0 ? y < range : y > 0) {
            y = Math.max(0, Math.min(range, y + dir * stepPx));
            el.scrollTop = y;
            await TB.nextFrame();
            const now = ChromeUtils.now();
            frames.push(now - last);
            last = now;
          }
        }
      }
    }
    const lag = probe.stop();
    const s = TB.stats(frames);
    return {
      scrollRangePx: range,
      clientHeightPx: el.clientHeight,
      totalMs: ChromeUtils.now() - start,
      frames: s,
      framesOver33: frames.filter(f => f > 33.4).length,
      framesOver50: frames.filter(f => f > 50).length,
      framesOver200: frames.filter(f => f > 200).length,
      parentLag: lag,
    };
  },

  // Functional check of Firefox's TabUnloader (the module the macOS memory
  // watcher would call under memory pressure when lowMemoryResponseMask & 1).
  async probeUnloader() {
    const { TabUnloader } = ChromeUtils.importESModule(
      "moz-src:///browser/components/tabbrowser/TabUnloader.sys.mjs"
    );
    const before = TB.tabCounts();
    const unloaded = await TabUnloader.unloadLeastRecentlyUsedTab(null);
    await TB.sleep(500);
    return { unloaded, before, after: TB.tabCounts() };
  },

  async startupInfo() {
    const info = Services.startup.getStartupInfo();
    const out = {};
    const base = info.process ? info.process.getTime() : 0;
    for (const [k, v] of Object.entries(info)) {
      if (v && typeof v.getTime == "function") {
        out[k] = v.getTime() - base;
      }
    }
    return out;
  },

  async waitForSessionRestored(timeoutMs) {
    const deadline = ChromeUtils.now() + timeoutMs;
    while (ChromeUtils.now() < deadline) {
      const info = Services.startup.getStartupInfo();
      if (info.sessionRestored && info.sessionRestored.getTime() > 0) {
        return true;
      }
      await TB.sleep(100);
    }
    return false;
  },
};
