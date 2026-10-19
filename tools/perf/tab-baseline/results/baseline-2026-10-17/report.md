# Tab-scale baseline

- Generated: 2026-10-17T14:16:18  
- App: `/Users/me/Developer/arclike/desktop/engine/obj-aarch64-apple-darwin/dist/Nightly.app` (1.23.2b, build 20261016052538)  
- Repo: 7ca93c9 Empty tab: aurora backdrop, glass URL bar and most visited sites (dirty)  
- Machine: Apple M5 Pro / 24 GB / 18 cpus / macOS 26.6.2  
- Command: `python3 tools/perf/tab-baseline/run.py --probe-unloader --max-load 6 --out tools/perf/tab-baseline/results/baseline-2026-10-17 --workdir /Users/me/Documents/omp/.temp/NightlyBaseline/work`  
- Open mode: loadTabs; pref overrides: none

Per run (load = 1-min `vm.loadavg` before/after the run):

| metric | 30×1 | 30×2 | 60×1 | 60×2 | 120×1 | 120×2 |
|---|---|---|---|---|---|---|
| load1_before | 5.4 | 5.5 | 5.5 | 4.5 | 4.6 | 5.7 |
| load1_after | 6.4 | 6.8 | 4.5 | 4.6 | 12.6 | 3.9 |
| open_mode | loadTabs | loadTabs | loadTabs | loadTabs | loadTabs | loadTabs |
| open_create_ms | 876.8 | 753.1 | 1619.6 | 1535.2 | 3828.6 | 3294.0 |
| open_all_loaded_ms | 2638.0 | 1837.1 | 3813.0 | 4140.1 | 11028.5 | 8709.9 |
| open_parent_lag_max_ms | 878.0 | 755.9 | 1637.5 | 1553.2 | 3875.7 | 3342.7 |
| open_parent_lag_p95_ms | 32.3 | 19.4 | 14.2 | 12.3 | 8.4 | 9.5 |
| open_parent_lag_over50 | 2 | 1 | 2 | 2 | 1 | 1 |
| open_parent_lag_over200 | 1 | 1 | 1 | 1 | 1 | 1 |
| loaded_rss_mb | 4135.6 | 4270.7 | 8034.0 | 8043.1 | 12331.8 | 12773.0 |
| loaded_footprint_mb | 2241.9 | 2138.1 | 3611.6 | 3696.1 | 6263.7 | 6297.4 |
| loaded_processes | 41 | 41 | 71 | 71 | 131 | 131 |
| loaded_content_processes | 33 | 33 | 63 | 63 | 123 | 123 |
| loaded_parent_footprint_mb | 276.8 | 264.4 | 318.5 | 321.2 | 288.2 | 317.8 |
| loaded_gpu_footprint_mb | 390.9 | 304.2 | 304.0 | 388.3 | 412.3 | 347.5 |
| switch_n | 30 | 30 | 30 | 30 | 30 | 30 |
| switch_layers_median_ms | 4.8 | 5.0 | 6.5 | 7.5 | 5.5 | 5.9 |
| switch_layers_p95_ms | 8.6 | 10.4 | 14.6 | 10.9 | 13.3 | 8.0 |
| switch_layers_max_ms | 9.0 | 11.2 | 22.8 | 18.4 | 15.1 | 12.4 |
| switch_paint_median_ms | 11.3 | 10.7 | 12.9 | 14.0 | 13.5 | 11.4 |
| switch_paint_p95_ms | 19.4 | 26.7 | 28.5 | 19.5 | 28.0 | 18.9 |
| switch_over50_layers | 0 | 0 | 0 | 0 | 0 | 0 |
| scroll_range_px | 650 | 650 | 1850 | 1850 | 4250 | 4250 |
| scroll_frames | 68 | 68 | 188 | 188 | 428 | 428 |
| scroll_frame_median_ms | 6.3 | 6.2 | 6.2 | 6.2 | 6.2 | 6.2 |
| scroll_frame_p95_ms | 6.7 | 7.0 | 6.9 | 6.5 | 7.4 | 7.6 |
| scroll_frame_max_ms | 6.8 | 7.1 | 7.0 | 7.0 | 7.8 | 7.8 |
| scroll_frames_over50 | 0 | 0 | 0 | 0 | 0 | 0 |
| idle_rss_mb | 3443.0 | 4026.5 | 6444.8 | 7185.7 | 10510.2 | 11544.5 |
| idle_footprint_mb | 2484.8 | 2560.9 | 3591.6 | 3603.1 | 6193.0 | 6199.2 |
| idle_tabs_loaded | 31 | 31 | 61 | 61 | 121 | 121 |
| idle_tabs_unloaded | 0 | 0 | 0 | 0 | 0 | 0 |
| unloader_probe_unloaded | True | True | True | True | True | True |
| restore_first_paint_ms | 791 | 947 | 853 | 785 | 1349 | 805 |
| restore_session_restored_ms | 862 | 1023 | 946 | 856 | 1457 | 895 |
| restore_main_to_restored_ms | 823 | 981 | 914 | 813 | 1397 | 855 |
| restore_rss_mb | 1216.6 | 1221.3 | 1229.9 | 1225.8 | 1213.5 | 1195.2 |
| restore_footprint_mb | 732.9 | 730.5 | 741.8 | 904.3 | 680.0 | 750.2 |
| restore_tabs_total | 31 | 31 | 61 | 61 | 121 | 121 |
| restore_tabs_pending | 30 | 30 | 60 | 60 | 120 | 120 |

Run-to-run spread per tab count (|run max − run min| / mean):

| metric | 30 tabs mean | spread | 60 tabs mean | spread | 120 tabs mean | spread |
|---|---|---|---|---|---|---|
| load1_before | 5.5 | 2% | 5.0 | 21% | 5.2 | 23% |
| load1_after | 6.6 | 5% | 4.5 | 2% | 8.3 | 105% |
| open_mode |  |  |  |  |  |  |
| open_create_ms | 815.0 | 15% | 1577.4 | 5% | 3561.3 | 15% |
| open_all_loaded_ms | 2237.6 | 36% | 3976.6 | 8% | 9869.2 | 23% |
| open_parent_lag_max_ms | 817.0 | 15% | 1595.3 | 5% | 3609.2 | 15% |
| open_parent_lag_p95_ms | 25.9 | 50% | 13.3 | 14% | 8.9 | 12% |
| open_parent_lag_over50 | 1.5 | 67% | 2.0 | 0% | 1.0 | 0% |
| open_parent_lag_over200 | 1.0 | 0% | 1.0 | 0% | 1.0 | 0% |
| loaded_rss_mb | 4203.1 | 3% | 8038.6 | 0% | 12552.4 | 4% |
| loaded_footprint_mb | 2190.0 | 5% | 3653.9 | 2% | 6280.6 | 1% |
| loaded_processes | 41.0 | 0% | 71.0 | 0% | 131.0 | 0% |
| loaded_content_processes | 33.0 | 0% | 63.0 | 0% | 123.0 | 0% |
| loaded_parent_footprint_mb | 270.6 | 5% | 319.8 | 1% | 303.0 | 10% |
| loaded_gpu_footprint_mb | 347.5 | 25% | 346.2 | 24% | 379.9 | 17% |
| switch_n | 30.0 | 0% | 30.0 | 0% | 30.0 | 0% |
| switch_layers_median_ms | 4.9 | 5% | 7.0 | 14% | 5.7 | 8% |
| switch_layers_p95_ms | 9.5 | 19% | 12.8 | 29% | 10.6 | 50% |
| switch_layers_max_ms | 10.1 | 22% | 20.6 | 21% | 13.7 | 20% |
| switch_paint_median_ms | 11.0 | 5% | 13.5 | 8% | 12.5 | 17% |
| switch_paint_p95_ms | 23.0 | 31% | 24.0 | 37% | 23.4 | 39% |
| switch_over50_layers | 0.0 | 0% | 0.0 | 0% | 0.0 | 0% |
| scroll_range_px | 650.0 | 0% | 1850.0 | 0% | 4250.0 | 0% |
| scroll_frames | 68.0 | 0% | 188.0 | 0% | 428.0 | 0% |
| scroll_frame_median_ms | 6.3 | 0% | 6.2 | 0% | 6.2 | 0% |
| scroll_frame_p95_ms | 6.9 | 5% | 6.7 | 7% | 7.5 | 4% |
| scroll_frame_max_ms | 6.9 | 3% | 7.0 | 0% | 7.8 | 0% |
| scroll_frames_over50 | 0.0 | 0% | 0.0 | 0% | 0.0 | 0% |
| idle_rss_mb | 3734.8 | 16% | 6815.2 | 11% | 11027.3 | 9% |
| idle_footprint_mb | 2522.9 | 3% | 3597.4 | 0% | 6196.1 | 0% |
| idle_tabs_loaded | 31.0 | 0% | 61.0 | 0% | 121.0 | 0% |
| idle_tabs_unloaded | 0.0 | 0% | 0.0 | 0% | 0.0 | 0% |
| unloader_probe_unloaded |  |  |  |  |  |  |
| restore_first_paint_ms | 869.0 | 18% | 819.0 | 8% | 1077.0 | 51% |
| restore_session_restored_ms | 942.5 | 17% | 901.0 | 10% | 1176.0 | 48% |
| restore_main_to_restored_ms | 902.0 | 18% | 863.5 | 12% | 1126.0 | 48% |
| restore_rss_mb | 1219.0 | 0% | 1227.9 | 0% | 1204.4 | 2% |
| restore_footprint_mb | 731.7 | 0% | 823.0 | 20% | 715.1 | 10% |
| restore_tabs_total | 31.0 | 0% | 61.0 | 0% | 121.0 | 0% |
| restore_tabs_pending | 30.0 | 0% | 60.0 | 0% | 120.0 | 0% |
