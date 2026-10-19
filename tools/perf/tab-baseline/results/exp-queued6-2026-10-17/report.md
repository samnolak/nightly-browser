# Tab-scale baseline

- Generated: 2026-10-17T14:46:07  
- App: `/Users/igo.shulga/Developer/arclike/desktop/engine/obj-aarch64-apple-darwin/dist/Nightly.app` (1.23.2b, build 20261016052538)  
- Repo: 7ca93c9 Empty tab: aurora backdrop, glass URL bar and most visited sites (dirty)  
- Machine: Apple M5 Pro / 24 GB / 18 cpus / macOS 26.6.2  
- Command: `python3 tools/perf/tab-baseline/run.py --tabs 120 --runs 2 --no-restore --max-load 6 --open-mode queued --queue-size 6 --workdir /Users/igo.shulga/Documents/omp/.temp/NightlyBaseline/work --out tools/perf/tab-baseline/results/exp-queued6-2026-10-17`  
- Open mode: queued; pref overrides: none

Per run (load = 1-min `vm.loadavg` before/after the run):

| metric | 120×1 | 120×2 |
|---|---|---|
| load1_before | 5.9 | 3.9 |
| load1_after | 3.9 | 4.3 |
| open_mode | queued:6 | queued:6 |
| open_create_ms | 57.1 | 59.1 |
| open_all_loaded_ms | 8650.4 | 8435.4 |
| open_parent_lag_max_ms | 70.9 | 75.9 |
| open_parent_lag_p95_ms | 25.7 | 24.0 |
| open_parent_lag_over50 | 1 | 1 |
| open_parent_lag_over200 | 0 | 0 |
| loaded_rss_mb | 10538.8 | 11702.9 |
| loaded_footprint_mb | 6251.6 | 6337.3 |
| loaded_processes | 131 | 131 |
| loaded_content_processes | 123 | 123 |
| loaded_parent_footprint_mb | 298.8 | 291.9 |
| loaded_gpu_footprint_mb | 453.6 | 507.2 |
| switch_n | 30 | 30 |
| switch_layers_median_ms | 6.6 | 6.4 |
| switch_layers_p95_ms | 22.4 | 8.3 |
| switch_layers_max_ms | 31.8 | 17.4 |
| switch_paint_median_ms | 12.9 | 12.2 |
| switch_paint_p95_ms | 36.6 | 19.9 |
| switch_over50_layers | 0 | 0 |
| scroll_range_px | 4250 | 4250 |
| scroll_frames | 428 | 428 |
| scroll_frame_median_ms | 6.2 | 6.2 |
| scroll_frame_p95_ms | 6.9 | 6.9 |
| scroll_frame_max_ms | 7.1 | 7.0 |
| scroll_frames_over50 | 0 | 0 |
| idle_rss_mb | 10247.5 | 10729.6 |
| idle_footprint_mb | 6374.3 | 6374.5 |
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
| load1_before | 4.9 | 41% |
| load1_after | 4.1 | 10% |
| open_mode |  |  |
| open_create_ms | 58.1 | 3% |
| open_all_loaded_ms | 8542.9 | 3% |
| open_parent_lag_max_ms | 73.4 | 7% |
| open_parent_lag_p95_ms | 24.9 | 7% |
| open_parent_lag_over50 | 1.0 | 0% |
| open_parent_lag_over200 | 0.0 | 0% |
| loaded_rss_mb | 11120.8 | 10% |
| loaded_footprint_mb | 6294.5 | 1% |
| loaded_processes | 131.0 | 0% |
| loaded_content_processes | 123.0 | 0% |
| loaded_parent_footprint_mb | 295.3 | 2% |
| loaded_gpu_footprint_mb | 480.4 | 11% |
| switch_n | 30.0 | 0% |
| switch_layers_median_ms | 6.5 | 3% |
| switch_layers_p95_ms | 15.3 | 92% |
| switch_layers_max_ms | 24.6 | 58% |
| switch_paint_median_ms | 12.6 | 6% |
| switch_paint_p95_ms | 28.2 | 59% |
| switch_over50_layers | 0.0 | 0% |
| scroll_range_px | 4250.0 | 0% |
| scroll_frames | 428.0 | 0% |
| scroll_frame_median_ms | 6.2 | 0% |
| scroll_frame_p95_ms | 6.9 | 1% |
| scroll_frame_max_ms | 7.1 | 0% |
| scroll_frames_over50 | 0.0 | 0% |
| idle_rss_mb | 10488.6 | 5% |
| idle_footprint_mb | 6374.4 | 0% |
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
