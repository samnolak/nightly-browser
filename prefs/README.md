# Browser Preferences

This directory contains configuration files for Zen. They are divided by folder according to the source / component they belong to and further divided by file according to their purpose.

- `firefox/`: Preferences to override Firefox defaults.
- `zen/`: Preferences to configure Zen-specific features.
- `nightly/`: Nightly Browser privacy defaults (no background connections the user did not ask for).
- `privatefox/` & `fastfox/`: _Some_ of the preferences got extracted from [Betterfox](https://github.com/yokoffing/Betterfox).

## Local automatic URL groups

Settings → **Tab Management → Automatic URL groups** controls `nightly/auto-groups.yaml`.
`zen.tabs.auto-groups.enabled` defaults to `true`; `threshold` defaults to four and
accepts 3–10. Existing automatic groups dissolve at two tabs regardless of the
creation threshold. `excluded-domains` accepts whitespace/comma-separated domain
names. `path-rules` accepts `domain=depth` entries, with depth 1–5; for example,
`github.com=1` groups by organization and `github.com=2` by repository. Apply the
domain/path fields together with **Apply domain and path rules**. Invalid fields
are not saved.

Keys use Gecko's public suffix service (eTLD+1); paths are case-sensitive and
queries/fragments do not affect grouping. Groups are isolated by workspace.
Pinned/essential tabs, folders, split views, and manual groups are excluded.
Dragging a tab out excludes it from automatic collection, including after session
restore. Rename or recolor via the group label's context menu to make the group
manual. Group identity and per-tab exclusions use local SessionStore custom tab
values; pending tabs are classified without loading them. No team publishing or
cloud synchronization is introduced.

Canonical code is in `src/zen/common/modules/ZenAutoGroups.mjs` and
`ZenAutoGroupRules.mjs`, registered in the common chrome manifest/preloaded scripts.
After the normal source import and UI build, the browser test command from the
desktop root is `npm test -- tabs/browser_tabs_auto_groups.js`. For native smoke,
run `npm start`, open four same-site temporary tabs in one workspace, close to
three (group remains), then two (group dissolves). Repeat with a manually
extracted tab and a renamed/recolored group, switch workspaces, and restart with
session continuation enabled. The browser tests additionally exercise actual
SessionStore round trips, public suffix/path matching, exclusions, and settings.
