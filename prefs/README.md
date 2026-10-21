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

## Open links in apps

Settings → **Tab Management → Open links in apps** controls `zen/open-in-app.yaml`.
A tab's top-level navigation (a click, a typed URL, a link from another app or
from Ombra's Browser page) to a page an installed desktop app opens is stopped
before any request goes out and handed to the app through LaunchServices; a tab
opened only for that link closes, any other tab stays on its page. Known apps
and the links they take: Figma (files, boards, prototypes, file browser), Zoom
(`/j/`, `/w/` meetings → `zoommtg://`), Microsoft Teams (`/l/` → `msteams:`),
Slack (`app.slack.com/client/…`), Telegram (`t.me` → `tg://`), Notion pages,
Linear issues/projects, Spotify, Discord, Толк (`*.ktalk.ru`, `*.ktalk.kz`,
`talk.skbkontur.ru` → `ktalk://`), Яндекс Телемост (`/j/` → `telemost://`),
Яндекс Музыка and Time (`time.example.ru`). An app is installed when macOS has a
handler for its URL scheme (the app's `CFBundleURLTypes`); its name is the one
LaunchServices reports. macOS offers no public lookup of an app's associated
domains for https links, so the site → app mapping is the list in
`src/zen/open-in-app/ZenOpenInAppRules.sys.mjs`.

Per app `zen.open-in-app.app.<id>` is `always` (default), `ask` (a tab prompt with
“Remember”) or `never`. Frames, subresources, pinned tabs, Glance, back/forward,
reloads, session restore, links within the app's own site already open in the
tab, and pages navigating by themselves without a click stay in the browser.
Hold ⌥ Option while opening a link, use **Open Link in Browser** in the link's
context menu, or the toast's button to keep a link in the browser once.

Tests: `./mach test zen/open-in-app/tests/` (matching for every known app, the
decision table, and real navigations with a fake app on example.org). The
embedded path is Ombra's `NightlyAcceptance.OpenInApp.cs` (driver `openinapp`).

## Augur preconnection (Ombra's runtime)

`nightly/augur.yaml`: `ombra.augur.enabled` (default `true`) lets Ombra's embedded
runtime preconnect to the origin of a navigation Ombra is about to cause: an
agent's open, click or goto, or an address the user committed (protocol 5's
`Command{speculate}`, `src/zen/embed/ZenEmbedAugur.sys.mjs`). A hint opens up to
three connections (DNS, TCP, TLS; never an HTTP request, so no cookie is sent)
with the target window's OriginAttributes, within budgets of 6 sockets in all and
3 per origin, and only while online, not on a mobile link and not under critical
memory pressure. The global speculative connections in `nightly/privacy.yaml`
stay off; the standalone browser never preconnects. How many connections a hint
gets depends on its source's calibrated probability, learnt from outcomes and
kept in `<profile>/augur-calibration.json` (per source only `a`, `b`, `n` and
`sumSquaredError`; no URL, origin or history). `ombra.augur.log-level` sets its
console messages (`Info`: one per hint and per outcome).
