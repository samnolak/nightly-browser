# Tab-scale baseline

- Generated: 2026-10-17T17:04:59  
- App: `/Users/igo.shulga/Developer/arclike/desktop/engine/obj-aarch64-apple-darwin/dist/Nightly.app` (1.23.2b, build 20261017164525)  
- Repo: 7ca93c9 Empty tab: aurora backdrop, glass URL bar and most visited sites (dirty)  
- Machine: Apple M5 Pro / 24 GB / 18 cpus / macOS 26.6.2  
- Command: `python3 tools/perf/tab-baseline/run.py --tabs 120 --runs 2 --idle 120 --no-restore --max-load 4 --max-load-wait 240 --pref zen.tabs.load-queue.enabled=false --workdir /Users/igo.shulga/Documents/omp/.temp/NightlyBaseline-2/work-false --out tools/perf/tab-baseline/results/ab-queue-false-2026-10-17`  
- Open mode: loadTabs; pref overrides: {"zen.tabs.load-queue.enabled": false}

Per run (load = 1-min `vm.loadavg` before/after the run):

| metric | 120×1 | 120×2 |
|---|---|---|
| load1_before | 3.8 | 2.5 |
| load1_after | 2.5 | 1.8 |
| open_mode | loadTabs | loadTabs |
| open_create_ms | 3197.2 | 3179.8 |
| open_all_loaded_ms | 7431.0 | 7804.7 |
| open_parent_lag_max_ms | 3235.2 | 3216.5 |
| open_parent_lag_p95_ms | 15.4 | 19.4 |
| open_parent_lag_over50 | 2 | 2 |
| open_parent_lag_over200 | 1 | 1 |
| loaded_rss_mb | 14544.2 | 14773.3 |
| loaded_footprint_mb | 6555.1 | 6544.6 |
| loaded_processes | 131 | 131 |
| loaded_content_processes | 123 | 123 |
| loaded_parent_footprint_mb | 334.7 | 339.5 |
| loaded_gpu_footprint_mb | 469.4 | 431.9 |
| switch_n | 30 | 30 |
| switch_layers_median_ms | 7.8 | 9.0 |
| switch_layers_p95_ms | 12.6 | 11.4 |
| switch_layers_max_ms | 15.9 | 18.8 |
| switch_paint_median_ms | 12.6 | 13.8 |
| switch_paint_p95_ms | 23.7 | 22.1 |
| switch_over50_layers | 0 | 0 |
| scroll_range_px | 4250 | 4250 |
| scroll_frames | 428 | 428 |
| scroll_frame_median_ms | 6.2 | 6.2 |
| scroll_frame_p95_ms | 7.7 | 6.6 |
| scroll_frame_max_ms | 7.9 | 14.0 |
| scroll_frames_over50 | 0 | 0 |
| idle_rss_mb | 14119.8 | 14213.8 |
| idle_footprint_mb | 6614.1 | 6612.7 |
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
| load1_before | 3.2 | 41% |
| load1_after | 2.1 | 35% |
| open_mode |  |  |
| open_create_ms | 3188.5 | 1% |
| open_all_loaded_ms | 7617.9 | 5% |
| open_parent_lag_max_ms | 3225.9 | 1% |
| open_parent_lag_p95_ms | 17.4 | 23% |
| open_parent_lag_over50 | 2.0 | 0% |
| open_parent_lag_over200 | 1.0 | 0% |
| loaded_rss_mb | 14658.7 | 2% |
| loaded_footprint_mb | 6549.8 | 0% |
| loaded_processes | 131.0 | 0% |
| loaded_content_processes | 123.0 | 0% |
| loaded_parent_footprint_mb | 337.1 | 1% |
| loaded_gpu_footprint_mb | 450.7 | 8% |
| switch_n | 30.0 | 0% |
| switch_layers_median_ms | 8.4 | 14% |
| switch_layers_p95_ms | 12.0 | 10% |
| switch_layers_max_ms | 17.4 | 16% |
| switch_paint_median_ms | 13.2 | 9% |
| switch_paint_p95_ms | 22.9 | 7% |
| switch_over50_layers | 0.0 | 0% |
| scroll_range_px | 4250.0 | 0% |
| scroll_frames | 428.0 | 0% |
| scroll_frame_median_ms | 6.2 | 0% |
| scroll_frame_p95_ms | 7.1 | 17% |
| scroll_frame_max_ms | 10.9 | 56% |
| scroll_frames_over50 | 0.0 | 0% |
| idle_rss_mb | 14166.8 | 1% |
| idle_footprint_mb | 6613.4 | 0% |
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
