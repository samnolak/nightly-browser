# Tab-scale baseline

- Generated: 2026-10-17T17:10:33  
- App: `/Users/me/Developer/arclike/desktop/engine/obj-aarch64-apple-darwin/dist/Nightly.app` (1.23.2b, build 20261017164525)  
- Repo: 7ca93c9 Empty tab: aurora backdrop, glass URL bar and most visited sites (dirty)  
- Machine: Apple M5 Pro / 24 GB / 18 cpus / macOS 26.6.2  
- Command: `python3 tools/perf/tab-baseline/run.py --tabs 120 --runs 2 --idle 120 --no-restore --max-load 4 --max-load-wait 240 --pref zen.tabs.load-queue.enabled=true --workdir /Users/me/Documents/omp/.temp/NightlyBaseline-2/work-true --out tools/perf/tab-baseline/results/ab-queue-true-2026-10-17`  
- Open mode: loadTabs; pref overrides: {"zen.tabs.load-queue.enabled": true}

Per run (load = 1-min `vm.loadavg` before/after the run):

| metric | 120×1 | 120×2 |
|---|---|---|
| load1_before | 1.8 | 2.9 |
| load1_after | 2.9 | 3.5 |
| open_mode | loadTabs | loadTabs |
| open_create_ms | 61.9 | 62.6 |
| open_all_loaded_ms | 8853.2 | 8439.6 |
| open_parent_lag_max_ms | 73.5 | 74.8 |
| open_parent_lag_p95_ms | 21.5 | 20.6 |
| open_parent_lag_over50 | 1 | 1 |
| open_parent_lag_over200 | 0 | 0 |
| loaded_rss_mb | 14728.8 | 14790.0 |
| loaded_footprint_mb | 6630.7 | 6702.3 |
| loaded_processes | 131 | 131 |
| loaded_content_processes | 123 | 123 |
| loaded_parent_footprint_mb | 315.6 | 329.6 |
| loaded_gpu_footprint_mb | 511.1 | 503.7 |
| switch_n | 30 | 30 |
| switch_layers_median_ms | 7.6 | 5.9 |
| switch_layers_p95_ms | 9.8 | 8.9 |
| switch_layers_max_ms | 13.6 | 15.3 |
| switch_paint_median_ms | 13.2 | 10.9 |
| switch_paint_p95_ms | 18.0 | 18.2 |
| switch_over50_layers | 0 | 0 |
| scroll_range_px | 4250 | 4250 |
| scroll_frames | 428 | 428 |
| scroll_frame_median_ms | 6.2 | 6.2 |
| scroll_frame_p95_ms | 6.7 | 6.5 |
| scroll_frame_max_ms | 14.2 | 11.7 |
| scroll_frames_over50 | 0 | 0 |
| idle_rss_mb | 14937.7 | 14354.5 |
| idle_footprint_mb | 6696.3 | 6722.0 |
| idle_tabs_loaded | 121 | 121 |
| idle_tabs_unloaded | 0 | 0 |
| unloader_probe_unloaded |  |  |
| restore_first_paint_ms |  |  |
| restore_session_restored_ms |  |  |
| restore_main_to_restored_ms |  |  |
| restore_rss_mb |  |  |
| restore_footprint_mb |  |  |
| restore_tabs_total |  |  |
| restore_tabs_pending | 0 | 0 |

Run-to-run spread per tab count (|run max − run min| / mean):

| metric | 120 tabs mean | spread |
|---|---|---|
| load1_before | 2.3 | 48% |
| load1_after | 3.2 | 19% |
| open_mode |  |  |
| open_create_ms | 62.2 | 1% |
| open_all_loaded_ms | 8646.4 | 5% |
| open_parent_lag_max_ms | 74.2 | 2% |
| open_parent_lag_p95_ms | 21.0 | 4% |
| open_parent_lag_over50 | 1.0 | 0% |
| open_parent_lag_over200 | 0.0 | 0% |
| loaded_rss_mb | 14759.4 | 0% |
| loaded_footprint_mb | 6666.5 | 1% |
| loaded_processes | 131.0 | 0% |
| loaded_content_processes | 123.0 | 0% |
| loaded_parent_footprint_mb | 322.6 | 4% |
| loaded_gpu_footprint_mb | 507.4 | 1% |
| switch_n | 30.0 | 0% |
| switch_layers_median_ms | 6.7 | 25% |
| switch_layers_p95_ms | 9.4 | 9% |
| switch_layers_max_ms | 14.4 | 11% |
| switch_paint_median_ms | 12.0 | 19% |
| switch_paint_p95_ms | 18.1 | 1% |
| switch_over50_layers | 0.0 | 0% |
| scroll_range_px | 4250.0 | 0% |
| scroll_frames | 428.0 | 0% |
| scroll_frame_median_ms | 6.2 | 0% |
| scroll_frame_p95_ms | 6.6 | 4% |
| scroll_frame_max_ms | 13.0 | 19% |
| scroll_frames_over50 | 0.0 | 0% |
| idle_rss_mb | 14646.1 | 4% |
| idle_footprint_mb | 6709.2 | 0% |
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
