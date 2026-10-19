# Tab-scale baseline

Reproducible measurement of Nightly with 30, 60 and 120 tabs, for PRODUCT_DIRECTIONS B4 step 1
(roadmap item R0.4). The harness drives the built `Nightly.app` over Marionette, from the
privileged chrome context, with a fresh profile and local fixture pages. It needs no network.

## Run

```sh
python3 tools/perf/tab-baseline/run.py
```

The default run measures 30, 60 and 120 tabs, two runs each, and takes about 15 minutes. It
writes `results/<timestamp>/report.md`, `summary.csv` (one row per run) and `runs.json` (all
samples, per-process data, prefs and load averages). You need Python 3.9 or newer; the harness
uses only the standard library. By default it runs
`engine/obj-aarch64-apple-darwin/dist/Nightly.app`. To measure a different build, pass
`--app /path/To.app`. The harness finds a `nightly`, `firefox` or `zen` binary, so you can also
run it against vanilla Firefox or Zen upstream.

The browser window opens on screen at 1440×900 px. Do not cover it, minimize it or use the
machine heavily during a run: occluded windows are throttled, and other load shows up in the
numbers. The harness records the 1-minute `vm.loadavg` before and after every run and with every
memory sample. With `--max-load N`, each run waits until the 1-minute load average drops to N or
lower. The wait lasts at most `--max-load-wait` seconds; after that the run starts anyway and the
report shows the load.

Useful options:

| Option | Effect |
|---|---|
| `--tabs 120 --runs 3` | Choose the tab counts and the number of runs per count |
| `--idle 60` / `--settle 10` / `--warmup 5` | Seconds idle before the idle sample, after loading, and after startup |
| `--switches 30` | Number of measured tab switches (20 or more) |
| `--no-restore` | Skip the cold session-restore start |
| `--probe-unloader` | After the idle sample, call Firefox's `TabUnloader` once (functional check; changes tab state) |
| `--profile-open` | Save a parent-process Gecko profile of the open phase (`profile-open-*.json.gz`; open it in profiler.firefox.com) |
| `--pref name=value` | Add a user pref to the profile, for experiments; the report lists it |
| `--open-mode queued --queue-size 6` | Experiment: lazy tabs, at most N concurrent loads (not current product behaviour) |
| `--keep-profiles --workdir DIR` | Keep the temporary profiles and browser logs |

## Scenario

1. Create a fresh profile (`user.js` only). The profile disables network-calling services
   (updates, telemetry, Remote Settings, Safe Browsing, captive portal, prefetch), first-run
   screens and Zen's update popup. It maps `site01.test` … `site40.test` to 127.0.0.1 with
   `network.dns.localDomains`. Marionette's own "recommended prefs" are off
   (`remote.prefs.recommended=false`) because they disable `browser.tabs.unloadOnLowMemory`, the
   process priority manager and background main-thread priority, which would bias this
   benchmark.
2. Start `nightly -marionette -remote-allow-system-access`, switch Marionette to chrome context,
   wait for `--warmup`, then take the `startup` sample.
3. Open N tabs with one `gBrowser.loadTabs(urls, {inBackground: true})` call, the "open all in
   tabs" path, and wait until every tab has stopped loading. The tab list repeats in groups of
   three per site (text, images, app), so 120 tabs use 40 sites. Under Fission, every tab can
   get its own content process, as on real multi-site sessions.
   - `text.html`: about 60 KB of static text, no script.
   - `images.html`: 8 incompressible 640×480 PNGs (about 1.2 MB each once decoded).
   - `app.html`: about 200k JS objects, a 2000-row table, a canvas animated with
     `requestAnimationFrame`, a 1 s timer and a CSS animation.
4. Wait `--settle`, then take the `loaded` sample.
5. Make 30 seeded pseudo-random tab switches, 300 ms apart.
6. Scroll the active Zen vertical tab list top → bottom → top twice, 40 px per frame.
7. Stay idle for `--idle`, take the `idle` sample, then optionally run the unloader probe.
8. Quit through Marionette. The session is saved, because `browser.startup.page=3`.
9. Cold start on the same profile: wait for `sessionRestored`, read
   `Services.startup.getStartupInfo()`, wait `--settle`, then take the `restored` sample.

## Metrics

| Column | Meaning |
|---|---|
| `open_create_ms` | Duration of the synchronous `loadTabs` call, a single main-thread task in the parent |
| `open_all_loaded_ms` | From the call until every new tab has finished loading (`busy` cleared, URL committed, not loading) |
| `open_parent_lag_*` | Parent main-thread event-loop lag during opening, from a 16 ms timer chain; max = the longest freeze of the browser UI |
| `*_footprint_mb` | Sum of `ChromeUtils.requestProcInfo().memory` (macOS physical footprint, which Activity Monitor and `about:processes` show) over all processes |
| `*_rss_mb` | Sum of `ps` RSS over the parent process tree. It counts shared pages more than once, so use footprint for budgets |
| `loaded_processes` / `loaded_content_processes` | All processes, and content processes in use (preallocated spares excluded; see `byType` in `runs.json`) |
| `switch_layers_*` | Talos `tabswitch` method: from `selectedTab = tab` until the browser has layers (`MozLayerTreeReady`) |
| `switch_paint_*` | From `selectedTab = tab` to the first composited window paint (`MozAfterPaint`) after the layers are ready: the first frame that shows the tab |
| `scroll_frame_*` | rAF intervals while the tab list scrolls (the display runs at 120 Hz, so about 8.3 ms per frame) |
| `idle_tabs_unloaded` | Tabs that are pending or discarded after the idle period |
| `restore_session_restored_ms` | From process creation to `sessionRestored`; includes OS launch time, which grows with load |
| `restore_main_to_restored_ms` | From XRE `main` to `sessionRestored` (less sensitive to load) |

## Baseline 2026-10-17

- Build: Nightly 1.23.2b, build 20261016052538, Gecko platform 158.0. Repo at `7ca93c9` with
  other agents' uncommitted work in the tree. Apple M5 Pro, 24 GB RAM, 18 CPUs, macOS 26.6.2,
  2× display scale.
- Raw data: `results/baseline-2026-10-17/`, plus a second pair of 120-tab runs in
  `results/baseline-120-rerun-2026-10-17/`. In the first set, the 120×1 cold restore ran at a
  load of 12.6, so 120 tabs were measured again.
- Load before each run was between 3.9 and 5.7. Other Nightly instances (agents' test runs) were
  active on the machine at the same time.

Means over runs; the range across runs is in brackets:

| | 30 tabs (2 runs) | 60 tabs (2 runs) | 120 tabs (4 runs) |
|---|---|---|---|
| UI freeze while opening (parent max lag), ms | 817 [756–878] | 1595 [1553–1638] | 3428 [3243–3876] |
| All tabs loaded, ms | 2238 [1837–2638] | 3977 [3813–4140] | 8823 [7467–11028] |
| Footprint after load, GB | 2.19 [2.14–2.24] | 3.65 [3.61–3.70] | 6.36 [6.26–6.46] |
| Footprint after 60 s idle, GB | 2.52 | 3.60 | 6.22 [6.19–6.25] |
| Processes / content in use | 41 / 33 | 71 / 63 | 131 / 123 |
| Parent / GPU footprint after load, MB | 271 / 348 | 320 / 346 | 319 / 410 |
| Switch, layers ready, median / p95, ms | 4.9 / 9.5 | 7.0 / 12.8 | 6.7 / 11.1 |
| Switch, first frame, median / p95, ms | 11.0 / 23.0 | 13.5 / 24.0 | 12.8 / 22.0 |
| Tab-list scroll frame p95 / max, ms (0 frames > 50 ms) | 6.8 / 7.1 | 6.7 / 7.0 | 7.3 / 7.8 |
| Tabs unloaded after 60 s idle | 0 | 0 | 0 |
| Cold restore, main → sessionRestored, ms | 902 [823–981] | 864 [813–914] | 1176 [855–1397] |
| Cold restore footprint, GB (only the selected tab loaded) | 0.73 | 0.82 | 0.84 |

Run-to-run spread: memory and process counts are within 0–5 %. Freeze duration is within 15 %.
Switch medians are within 5–15 %; switch p95 varies 20–50 % because it comes from the slowest
1–2 of 30 samples. "All loaded" varies 8–36 %, because it depends on CPU contention from content
processes. Every run's `report.md` lists the spread per metric.

### Findings

1. **Bulk opening freezes the browser UI for about 28 ms per tab** (0.8 s at 30 tabs, 3.2–3.9 s
   at 120). `loadTabs` runs as a single task. A parent-only Gecko profile of the 120-tab open
   (`--profile-open`) attributes the cost as follows:
   - 76.5 % of the samples in `loadTabs` are `__psynch_cvwait` (libsystem_kernel, offset 0x450c),
     reached through `browser` `connectedCallback` → style flush → `nsFrameLoader::ShowRemoteFrame`
     → `ContentParent::CreateBrowser`. In other words, the main thread waits synchronously for a
     new content process to launch, once per tab.
   - Zen frames (`ZenSpaceManager.updateTabsContainers`, `#fixTabPositions`,
     `makeSureEmptyTabIsFirst`) account for 2.2 % of the samples.

   This is Gecko and Fission behaviour: `dom.ipc.processCount.webIsolated=4`, so every tab of
   this fixture set gets its own process. The cost is not specific to Zen, and the
   3-process preallocated pool cannot absorb 120 launches.
2. **No tab is ever unloaded.** Each item below was checked:
   - Zen's timer unloader is gone. Neither `zen.tab-unloader.enabled` nor
     `zen.tab-unloader.timeout-minutes` is defined at runtime, no `ZenTabUnloader` module or
     global exists, and `git log -S` finds no implementation since the import commit `fc27efb`.
     The only trace is a stale `Preferences.addAll` entry for `zen.tab-unloader.timeout-minutes`
     in `src/browser/components/preferences/zen-settings.js`.
   - The macOS memory-pressure response is off. At runtime, `browser.lowMemoryResponseMask` is
     `0` (default, not user-set). `firefox.js` sets it to 3 only `#if defined(NIGHTLY_BUILD)`,
     and this build is `RELEASE_OR_BETA` (`MOZ_UPDATE_CHANNEL=release`). With mask 0,
     `nsAvailableMemoryWatcher::LowMemoryResponse` (`xpcom/base/AvailableMemoryWatcherMac.cpp`)
     neither unloads tabs nor sends an internal `memory-pressure` notification.
   - `browser.tabs.unloadOnLowMemory=true`, and Firefox's `TabUnloader`, with Zen's patch, works
     when called: `--probe-unloader` unloaded one tab in each of 8/8 runs.
   - The harness cannot show the effect of the mask without real memory pressure.
     `memory_pressure -S` needs root (`kern.memorypressure_manual_trigger: Operation not
     permitted`), and filling the machine's RAM was not acceptable on a shared machine.
3. **Within budget:**
   - Switching to a loaded tab: p95 22–24 ms to the first frame, against a ≤ 50 ms budget.
   - Tab-list scrolling with 120 tabs: no frame over 7.8 ms.
   - Cold start restoring 120 tabs on demand: 0.86–1.40 s from main to `sessionRestored`,
     against a ≤ 3 s budget. One run under load 9 took 4.2 s from process creation, of which
     3.0 s came before `main`. RSS after restore is about 1.2 GB.

### Experiments (120 tabs, two runs each; not product changes)

| | Baseline (4 runs) | `--open-mode queued --queue-size 6` | `--pref dom.ipc.processCount.webIsolated=1` |
|---|---|---|---|
| UI freeze while opening, ms | 3243–3876 | 71–76 | 1408–1428 |
| All tabs loaded, ms | 7467–11028 | 8435–8650 | 5496–5720 |
| Footprint after load, GB | 6.26–6.46 | 6.25–6.34 | 4.63–4.66 |
| Processes | 131 | 131 | 51 |
| Switch, first frame, p95, ms | 18.9–28.0 | 19.9–36.6 | 18.5–19.7 |

Raw data: `results/exp-queued6-2026-10-17/` and `results/exp-webisolated1-2026-10-17/`.

### Candidate optimizations, ranked by evidence

1. **Bulk open with lazy tabs and a bounded load queue** (B4 step 2, "limit concurrent loads").
   In the experiment, the UI freeze dropped from 3.2–3.9 s to 71–76 ms, with no loss in time
   until all tabs are loaded. Implementing it means changing `Tabbrowser.loadTabs`, or the Zen
   and Places callers, plus the "queued" tab state from B4 step 3. That is bigger than a one-line
   change, so it was not done here.
2. **Fewer processes per site** (`dom.ipc.processCount.webIsolated` 4 → 1). Measured effect:
   27 % less footprint (6.4 → 4.6 GB), 131 → 51 processes, freeze 3.4 → 1.4 s, all tabs loaded
   8.8 → 5.6 s, and no change in switch latency. The trade-off is that same-site tabs share one
   process, so jank or a crash spreads to all of them. That is a product decision.
3. **Unload tabs on macOS memory pressure** (`browser.lowMemoryResponseMask=3`, as Mozilla
   Nightly does). This is a one-pref change. It only acts at the critical pressure level, and
   this harness cannot measure it without root.
4. **Timer-based unloading of inactive tabs** (B4 step 2), with exceptions for audio, forms and
   pinned tabs. No implementation exists today. Remove the stale settings entry or implement the
   feature.

## Not covered

- Real heavy sites (Pinterest, YouTube, Figma). The fixtures are deliberately offline and
  deterministic.
- Comparison with vanilla Firefox 157 and Zen upstream: use `--app`; no such build is
  installed on this machine.
- Long-task attribution while scrolling the tab list: use `--profile-open` as a template, or
  profile with about:profiling.
- Embedded or Ombra measurements, which depend on K1.
