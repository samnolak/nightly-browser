# Tab-scale baseline

- Generated: 2026-10-17T14:55:27  
- App: `/Users/me/Developer/arclike/desktop/engine/obj-aarch64-apple-darwin/dist/Nightly.app` (1.23.2b, build 20261016052538)  
- Repo: 7ca93c9 Empty tab: aurora backdrop, glass URL bar and most visited sites (dirty)  
- Machine: Apple M5 Pro / 24 GB / 18 cpus / macOS 26.6.2  
- Command: `python3 tools/perf/tab-baseline/run.py --tabs 120 --runs 2 --probe-unloader --max-load 6 --workdir /Users/me/Documents/omp/.temp/NightlyBaseline/work --out tools/perf/tab-baseline/results/baseline-120-rerun-2026-10-17`  
- Open mode: loadTabs; pref overrides: none

Per run (load = 1-min `vm.loadavg` before/after the run):

| metric | 120×1 | 120×2 |
|---|---|---|
| load1_before | 3.9 | 5.5 |
| load1_after | 5.5 | 8.6 |
| open_mode | loadTabs | loadTabs |
| open_create_ms | 3206.3 | 3214.8 |
| open_all_loaded_ms | 7466.7 | 8085.4 |
| open_parent_lag_max_ms | 3243.5 | 3252.6 |
| open_parent_lag_p95_ms | 20.1 | 18.9 |
| open_parent_lag_over50 | 2 | 2 |
| open_parent_lag_over200 | 1 | 1 |
| loaded_rss_mb | 13752.8 | 14457.2 |
| loaded_footprint_mb | 6428.6 | 6459.1 |
| loaded_processes | 131 | 131 |
| loaded_content_processes | 123 | 123 |
| loaded_parent_footprint_mb | 328.7 | 340.1 |
| loaded_gpu_footprint_mb | 472.5 | 405.9 |
| switch_n | 30 | 30 |
| switch_layers_median_ms | 7.5 | 8.0 |
| switch_layers_p95_ms | 11.1 | 12.1 |
| switch_layers_max_ms | 18.0 | 17.9 |
| switch_paint_median_ms | 13.2 | 13.0 |
| switch_paint_p95_ms | 20.0 | 20.9 |
| switch_over50_layers | 0 | 0 |
| scroll_range_px | 4250 | 4250 |
| scroll_frames | 428 | 428 |
| scroll_frame_median_ms | 6.2 | 6.2 |
| scroll_frame_p95_ms | 7.1 | 7.1 |
| scroll_frame_max_ms | 7.8 | 7.8 |
| scroll_frames_over50 | 0 | 0 |
| idle_rss_mb | 11166.0 | 12227.3 |
| idle_footprint_mb | 6251.2 | 6243.6 |
| idle_tabs_loaded | 121 | 121 |
| idle_tabs_unloaded | 0 | 0 |
| unloader_probe_unloaded | True | True |
| restore_first_paint_ms | 1116 | 4096 |
| restore_session_restored_ms | 1260 | 4240 |
| restore_main_to_restored_ms | 1207 | 1243 |
| restore_rss_mb | 1247.3 | 1253.4 |
| restore_footprint_mb | 889.2 | 1055.7 |
| restore_tabs_total | 121 | 121 |
| restore_tabs_pending | 120 | 120 |

Run-to-run spread per tab count (|run max − run min| / mean):

| metric | 120 tabs mean | spread |
|---|---|---|
| load1_before | 4.7 | 33% |
| load1_after | 7.1 | 43% |
| open_mode |  |  |
| open_create_ms | 3210.6 | 0% |
| open_all_loaded_ms | 7776.0 | 8% |
| open_parent_lag_max_ms | 3248.1 | 0% |
| open_parent_lag_p95_ms | 19.5 | 6% |
| open_parent_lag_over50 | 2.0 | 0% |
| open_parent_lag_over200 | 1.0 | 0% |
| loaded_rss_mb | 14105.0 | 5% |
| loaded_footprint_mb | 6443.9 | 0% |
| loaded_processes | 131.0 | 0% |
| loaded_content_processes | 123.0 | 0% |
| loaded_parent_footprint_mb | 334.4 | 3% |
| loaded_gpu_footprint_mb | 439.2 | 15% |
| switch_n | 30.0 | 0% |
| switch_layers_median_ms | 7.7 | 7% |
| switch_layers_p95_ms | 11.6 | 8% |
| switch_layers_max_ms | 18.0 | 1% |
| switch_paint_median_ms | 13.1 | 2% |
| switch_paint_p95_ms | 20.4 | 4% |
| switch_over50_layers | 0.0 | 0% |
| scroll_range_px | 4250.0 | 0% |
| scroll_frames | 428.0 | 0% |
| scroll_frame_median_ms | 6.2 | 0% |
| scroll_frame_p95_ms | 7.1 | 1% |
| scroll_frame_max_ms | 7.8 | 0% |
| scroll_frames_over50 | 0.0 | 0% |
| idle_rss_mb | 11696.6 | 9% |
| idle_footprint_mb | 6247.4 | 0% |
| idle_tabs_loaded | 121.0 | 0% |
| idle_tabs_unloaded | 0.0 | 0% |
| unloader_probe_unloaded |  |  |
| restore_first_paint_ms | 2606.0 | 114% |
| restore_session_restored_ms | 2750.0 | 108% |
| restore_main_to_restored_ms | 1225.0 | 3% |
| restore_rss_mb | 1250.4 | 0% |
| restore_footprint_mb | 972.4 | 17% |
| restore_tabs_total | 121.0 | 0% |
| restore_tabs_pending | 120.0 | 0% |
