# Tab-scale baseline

- Generated: 2026-10-17T16:50:00  
- App: `/Users/me/Developer/arclike/desktop/engine/obj-aarch64-apple-darwin/dist/Nightly.app` (1.23.2b, build 20261017164525)  
- Repo: 7ca93c9 Empty tab: aurora backdrop, glass URL bar and most visited sites (dirty)  
- Machine: Apple M5 Pro / 24 GB / 18 cpus / macOS 26.6.2  
- Command: `python3 tools/perf/tab-baseline/run.py --tabs 120 --runs 2 --probe-unloader --max-load 6 --workdir /Users/me/Documents/omp/.temp/NightlyBaseline-2/work --out tools/perf/tab-baseline/results/after-b4-120-2026-10-17`  
- Open mode: loadTabs; pref overrides: none

Per run (load = 1-min `vm.loadavg` before/after the run):

| metric | 120×1 | 120×2 |
|---|---|---|
| load1_before | 4.0 | 5.7 |
| load1_after | 18.9 | 3.6 |
| open_mode | loadTabs | loadTabs |
| open_create_ms | 58.4 | 61.4 |
| open_all_loaded_ms | 8659.0 | 8421.0 |
| open_parent_lag_max_ms | 85.4 | 67.2 |
| open_parent_lag_p95_ms | 23.0 | 17.7 |
| open_parent_lag_over50 | 2 | 1 |
| open_parent_lag_over200 | 0 | 0 |
| loaded_rss_mb | 14703.7 | 14793.0 |
| loaded_footprint_mb | 6603.5 | 6739.0 |
| loaded_processes | 131 | 131 |
| loaded_content_processes | 123 | 123 |
| loaded_parent_footprint_mb | 324.3 | 328.6 |
| loaded_gpu_footprint_mb | 501.2 | 522.8 |
| switch_n | 30 | 30 |
| switch_layers_median_ms | 8.3 | 7.8 |
| switch_layers_p95_ms | 12.2 | 11.6 |
| switch_layers_max_ms | 15.4 | 18.9 |
| switch_paint_median_ms | 13.9 | 13.9 |
| switch_paint_p95_ms | 21.1 | 20.4 |
| switch_over50_layers | 0 | 0 |
| scroll_range_px | 4250 | 4250 |
| scroll_frames | 428 | 428 |
| scroll_frame_median_ms | 6.2 | 6.2 |
| scroll_frame_p95_ms | 7.1 | 6.5 |
| scroll_frame_max_ms | 7.9 | 7.7 |
| scroll_frames_over50 | 0 | 0 |
| idle_rss_mb | 14983.6 | 14965.2 |
| idle_footprint_mb | 6853.3 | 6984.4 |
| idle_tabs_loaded | 121 | 121 |
| idle_tabs_unloaded | 0 | 0 |
| unloader_probe_unloaded | True | True |
| restore_first_paint_ms | 814 | 757 |
| restore_session_restored_ms | 915 | 853 |
| restore_main_to_restored_ms | 859 | 812 |
| restore_rss_mb | 1225.2 | 1238.3 |
| restore_footprint_mb | 786.4 | 908.8 |
| restore_tabs_total | 121 | 121 |
| restore_tabs_pending | 120 | 120 |

Run-to-run spread per tab count (|run max − run min| / mean):

| metric | 120 tabs mean | spread |
|---|---|---|
| load1_before | 4.9 | 36% |
| load1_after | 11.2 | 136% |
| open_mode |  |  |
| open_create_ms | 59.9 | 5% |
| open_all_loaded_ms | 8540.0 | 3% |
| open_parent_lag_max_ms | 76.3 | 24% |
| open_parent_lag_p95_ms | 20.4 | 26% |
| open_parent_lag_over50 | 1.5 | 67% |
| open_parent_lag_over200 | 0.0 | 0% |
| loaded_rss_mb | 14748.4 | 1% |
| loaded_footprint_mb | 6671.3 | 2% |
| loaded_processes | 131.0 | 0% |
| loaded_content_processes | 123.0 | 0% |
| loaded_parent_footprint_mb | 326.5 | 1% |
| loaded_gpu_footprint_mb | 512.0 | 4% |
| switch_n | 30.0 | 0% |
| switch_layers_median_ms | 8.0 | 7% |
| switch_layers_p95_ms | 11.9 | 5% |
| switch_layers_max_ms | 17.2 | 20% |
| switch_paint_median_ms | 13.9 | 0% |
| switch_paint_p95_ms | 20.7 | 4% |
| switch_over50_layers | 0.0 | 0% |
| scroll_range_px | 4250.0 | 0% |
| scroll_frames | 428.0 | 0% |
| scroll_frame_median_ms | 6.2 | 0% |
| scroll_frame_p95_ms | 6.8 | 9% |
| scroll_frame_max_ms | 7.8 | 2% |
| scroll_frames_over50 | 0.0 | 0% |
| idle_rss_mb | 14974.4 | 0% |
| idle_footprint_mb | 6918.8 | 2% |
| idle_tabs_loaded | 121.0 | 0% |
| idle_tabs_unloaded | 0.0 | 0% |
| unloader_probe_unloaded |  |  |
| restore_first_paint_ms | 785.5 | 7% |
| restore_session_restored_ms | 884.0 | 7% |
| restore_main_to_restored_ms | 835.5 | 6% |
| restore_rss_mb | 1231.8 | 1% |
| restore_footprint_mb | 847.6 | 14% |
| restore_tabs_total | 121.0 | 0% |
| restore_tabs_pending | 120.0 | 0% |
