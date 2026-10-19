# Tab-scale baseline

- Generated: 2026-10-17T14:50:43  
- App: `/Users/igo.shulga/Developer/arclike/desktop/engine/obj-aarch64-apple-darwin/dist/Nightly.app` (1.23.2b, build 20261016052538)  
- Repo: 7ca93c9 Empty tab: aurora backdrop, glass URL bar and most visited sites (dirty)  
- Machine: Apple M5 Pro / 24 GB / 18 cpus / macOS 26.6.2  
- Command: `python3 tools/perf/tab-baseline/run.py --tabs 120 --runs 2 --no-restore --max-load 6 --pref dom.ipc.processCount.webIsolated=1 --workdir /Users/igo.shulga/Documents/omp/.temp/NightlyBaseline/work --out tools/perf/tab-baseline/results/exp-webisolated1-2026-10-17`  
- Open mode: loadTabs; pref overrides: {"dom.ipc.processCount.webIsolated": 1}

Per run (load = 1-min `vm.loadavg` before/after the run):

| metric | 120×1 | 120×2 |
|---|---|---|
| load1_before | 4.3 | 3.6 |
| load1_after | 3.6 | 3.6 |
| open_mode | loadTabs | loadTabs |
| open_create_ms | 1391.0 | 1411.1 |
| open_all_loaded_ms | 5720.2 | 5495.6 |
| open_parent_lag_max_ms | 1408.1 | 1428.1 |
| open_parent_lag_p95_ms | 14.8 | 17.7 |
| open_parent_lag_over50 | 2 | 2 |
| open_parent_lag_over200 | 1 | 1 |
| loaded_rss_mb | 7777.4 | 7736.8 |
| loaded_footprint_mb | 4657.6 | 4633.7 |
| loaded_processes | 51 | 51 |
| loaded_content_processes | 43 | 43 |
| loaded_parent_footprint_mb | 329.2 | 329.4 |
| loaded_gpu_footprint_mb | 435.3 | 452.0 |
| switch_n | 30 | 30 |
| switch_layers_median_ms | 7.8 | 6.3 |
| switch_layers_p95_ms | 10.0 | 9.8 |
| switch_layers_max_ms | 16.4 | 15.0 |
| switch_paint_median_ms | 13.0 | 12.4 |
| switch_paint_p95_ms | 19.7 | 18.5 |
| switch_over50_layers | 0 | 0 |
| scroll_range_px | 4250 | 4250 |
| scroll_frames | 428 | 428 |
| scroll_frame_median_ms | 6.2 | 6.2 |
| scroll_frame_p95_ms | 6.9 | 6.7 |
| scroll_frame_max_ms | 7.1 | 8.0 |
| scroll_frames_over50 | 0 | 0 |
| idle_rss_mb | 4897.2 | 7475.1 |
| idle_footprint_mb | 4496.3 | 4765.8 |
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
| load1_before | 3.9 | 18% |
| load1_after | 3.6 | 0% |
| open_mode |  |  |
| open_create_ms | 1401.1 | 1% |
| open_all_loaded_ms | 5607.9 | 4% |
| open_parent_lag_max_ms | 1418.1 | 1% |
| open_parent_lag_p95_ms | 16.2 | 18% |
| open_parent_lag_over50 | 2.0 | 0% |
| open_parent_lag_over200 | 1.0 | 0% |
| loaded_rss_mb | 7757.1 | 1% |
| loaded_footprint_mb | 4645.6 | 1% |
| loaded_processes | 51.0 | 0% |
| loaded_content_processes | 43.0 | 0% |
| loaded_parent_footprint_mb | 329.3 | 0% |
| loaded_gpu_footprint_mb | 443.6 | 4% |
| switch_n | 30.0 | 0% |
| switch_layers_median_ms | 7.0 | 21% |
| switch_layers_p95_ms | 9.9 | 2% |
| switch_layers_max_ms | 15.7 | 9% |
| switch_paint_median_ms | 12.7 | 5% |
| switch_paint_p95_ms | 19.1 | 6% |
| switch_over50_layers | 0.0 | 0% |
| scroll_range_px | 4250.0 | 0% |
| scroll_frames | 428.0 | 0% |
| scroll_frame_median_ms | 6.2 | 0% |
| scroll_frame_p95_ms | 6.8 | 3% |
| scroll_frame_max_ms | 7.5 | 12% |
| scroll_frames_over50 | 0.0 | 0% |
| idle_rss_mb | 6186.1 | 42% |
| idle_footprint_mb | 4631.0 | 6% |
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
