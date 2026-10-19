# Tab-scale baseline

- Generated: 2026-10-17T17:51:41  
- App: `/Users/me/Developer/arclike/desktop/engine/obj-aarch64-apple-darwin/dist/Nightly.app` (1.23.2b, build 20261017164525)  
- Repo: 7ca93c9 Empty tab: aurora backdrop, glass URL bar and most visited sites (dirty)  
- Machine: Apple M5 Pro / 24 GB / 18 cpus / macOS 26.6.2  
- Command: `python3 tools/perf/tab-baseline/run.py --tabs 120 --runs 1 --idle 300 --no-restore --max-load 4 --max-load-wait 300 --pref zen.tabs.load-queue.enabled=true --workdir /Users/me/Documents/omp/.temp/NightlyBaseline-2/work300-true-1 --out tools/perf/tab-baseline/results/ab300-queue-true-1-2026-10-17`  
- Open mode: loadTabs; pref overrides: {"zen.tabs.load-queue.enabled": true}

Per run (load = 1-min `vm.loadavg` before/after the run):

| metric | 120×1 |
|---|---|
| load1_before | 1.8 |
| load1_after | 3.4 |
| open_mode | loadTabs |
| open_create_ms | 61.1 |
| open_all_loaded_ms | 8957.9 |
| open_parent_lag_max_ms | 81.8 |
| open_parent_lag_p95_ms | 20.9 |
| open_parent_lag_over50 | 1 |
| open_parent_lag_over200 | 0 |
| loaded_rss_mb | 14279.0 |
| loaded_footprint_mb | 6365.9 |
| loaded_processes | 131 |
| loaded_content_processes | 123 |
| loaded_parent_footprint_mb | 308.8 |
| loaded_gpu_footprint_mb | 315.2 |
| switch_n | 30 |
| switch_layers_median_ms | 11.3 |
| switch_layers_p95_ms | 21.2 |
| switch_layers_max_ms | 23.1 |
| switch_paint_median_ms | 30.6 |
| switch_paint_p95_ms | 46.6 |
| switch_over50_layers | 0 |
| scroll_range_px | 4250 |
| scroll_frames | 428 |
| scroll_frame_median_ms | 16.5 |
| scroll_frame_p95_ms | 22.7 |
| scroll_frame_max_ms | 24.2 |
| scroll_frames_over50 | 0 |
| idle_rss_mb | 12467.8 |
| idle_footprint_mb | 6217.5 |
| idle_tabs_loaded | 121 |
| idle_tabs_unloaded | 0 |
| unloader_probe_unloaded |  |
| restore_first_paint_ms |  |
| restore_session_restored_ms |  |
| restore_main_to_restored_ms |  |
| restore_rss_mb |  |
| restore_footprint_mb |  |
| restore_tabs_total |  |
| restore_tabs_pending | 0 |

Run-to-run spread per tab count (|run max − run min| / mean):

| metric | 120 tabs mean | spread |
|---|---|---|
| load1_before | 1.8 | 0% |
| load1_after | 3.4 | 0% |
| open_mode |  |  |
| open_create_ms | 61.1 | 0% |
| open_all_loaded_ms | 8957.9 | 0% |
| open_parent_lag_max_ms | 81.8 | 0% |
| open_parent_lag_p95_ms | 20.9 | 0% |
| open_parent_lag_over50 | 1.0 | 0% |
| open_parent_lag_over200 | 0.0 | 0% |
| loaded_rss_mb | 14279.0 | 0% |
| loaded_footprint_mb | 6365.9 | 0% |
| loaded_processes | 131.0 | 0% |
| loaded_content_processes | 123.0 | 0% |
| loaded_parent_footprint_mb | 308.8 | 0% |
| loaded_gpu_footprint_mb | 315.2 | 0% |
| switch_n | 30.0 | 0% |
| switch_layers_median_ms | 11.3 | 0% |
| switch_layers_p95_ms | 21.2 | 0% |
| switch_layers_max_ms | 23.1 | 0% |
| switch_paint_median_ms | 30.6 | 0% |
| switch_paint_p95_ms | 46.6 | 0% |
| switch_over50_layers | 0.0 | 0% |
| scroll_range_px | 4250.0 | 0% |
| scroll_frames | 428.0 | 0% |
| scroll_frame_median_ms | 16.5 | 0% |
| scroll_frame_p95_ms | 22.7 | 0% |
| scroll_frame_max_ms | 24.2 | 0% |
| scroll_frames_over50 | 0.0 | 0% |
| idle_rss_mb | 12467.8 | 0% |
| idle_footprint_mb | 6217.5 | 0% |
| idle_tabs_loaded | 121.0 | 0% |
| idle_tabs_unloaded | 0.0 | 0% |
| unloader_probe_unloaded |  |  |
| restore_first_paint_ms |  |  |
| restore_session_restored_ms |  |  |
| restore_main_to_restored_ms |  |  |
| restore_rss_mb |  |  |
| restore_footprint_mb |  |  |
| restore_tabs_total |  |  |
| restore_tabs_pending | 0.0 | 0% |
