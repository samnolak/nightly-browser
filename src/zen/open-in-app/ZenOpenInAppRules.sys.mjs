// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * Which website links a desktop app opens, and whether a navigation should be
 * handed to it. Pure functions over URL objects and plain facts, so the
 * browser tests can check every rule without a network or an installed app.
 *
 * An app entry:
 *   id      - stable key; its setting is the pref zen.open-in-app.app.<id>.
 *   name    - shown until the OS names the app that holds the scheme.
 *   scheme  - the URL scheme the app declares (CFBundleURLTypes); the app is
 *             installed when the OS has a handler for it.
 *   toAppURL(url) - the app URL for a site URL (a URL object whose host is
 *             already known to belong to the app), or null when the app can't
 *             open that page (sign-in, marketing, downloads, ...).
 *   hosts   - exact host names, and/or
 *   matchHost(host) - for hosts with per-company subdomains.
 */

// Figma file types the desktop app opens itself. Every other path (marketing,
// help, auth, ...) is sent back to the browser by the app, so it must stay here.
const FIGMA_FILE_TYPES = new Set([
  "board",
  "buzz",
  "deck",
  "design",
  "file",
  "make",
  "proto",
  "rev",
  "site",
  "slides",
  "spec",
  "weave",
]);

// t.me/<name> where <name> is a Telegram username, not a t.me feature path.
const TELEGRAM_USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const TELEGRAM_RESERVED = new Set([
  "addemoji",
  "addlist",
  "addstickers",
  "addtheme",
  "boost",
  "c",
  "contact",
  "confirmphone",
  "iv",
  "joinchat",
  "login",
  "proxy",
  "s",
  "setlanguage",
  "share",
  "socks",
]);

// Telegram's own t.me -> tg:// translation keeps these query parameters.
function telegramQuery(base, url) {
  const params = new URLSearchParams(base);
  for (const [key, value] of url.searchParams) {
    if (!params.has(key)) {
      params.append(key, value);
    }
  }
  return params.toString();
}

const SPOTIFY_TYPES = new Set([
  "album",
  "artist",
  "audiobook",
  "chapter",
  "episode",
  "playlist",
  "show",
  "track",
  "user",
]);

const LINEAR_SECTIONS = new Set([
  "document",
  "initiative",
  "initiatives",
  "inbox",
  "issue",
  "my-issues",
  "project",
  "projects",
  "team",
  "view",
  "views",
]);

const YANDEX_MUSIC_SECTIONS = new Set([
  "album",
  "artist",
  "label",
  "playlists",
  "track",
  "users",
]);

// Толк (Kontur Talk) serves its web app from the same host; these paths are
// its API, sign-in and download pages, not something its window shows.
const KTALK_SERVICE_PATHS = /^\/(api|auth|download|login|logout|oauth|signin|sso|static|system)(\/|$)/i;

/** @type {Array<object>} */
export const OPEN_IN_APP_APPS = [
  {
    id: "figma",
    name: "Figma",
    scheme: "figma",
    hosts: ["www.figma.com", "figma.com"],
    toAppURL(url) {
      // The app opens these in the browser again (see its navigation config).
      if (url.searchParams.has("openInBrowser")) {
        return null;
      }
      const [type, key, sub] = url.pathname.split("/").slice(1);
      const isFileBrowser = type === "files";
      const isFile =
        FIGMA_FILE_TYPES.has(type) &&
        !!key &&
        sub !== "image" &&
        !(type === "file" && key === "employee");
      if (!isFileBrowser && !isFile) {
        return null;
      }
      // The app maps figma://<path> back onto https://www.figma.com/<path>.
      return `figma://${url.pathname.slice(1)}${url.search}${url.hash}`;
    },
  },
  {
    id: "zoom",
    name: "Zoom",
    scheme: "zoommtg",
    matchHost: host => host === "zoom.us" || host.endsWith(".zoom.us"),
    toAppURL(url) {
      // /j/<id> joins a meeting, /w/<id> a webinar. /wc/ is the web client the
      // user picked on purpose; /s/ (host start) and /my/ (personal links)
      // need Zoom's page to sign in or resolve the meeting first.
      const match = url.pathname.match(/^\/[jw]\/(\d{9,12})\/?$/);
      if (!match) {
        return null;
      }
      const params = new URLSearchParams({ action: "join", confno: match[1] });
      for (const key of ["pwd", "tk", "uname"]) {
        const value = url.searchParams.get(key);
        if (value) {
          params.set(key, value);
        }
      }
      return `zoommtg://${url.host}/join?${params}`;
    },
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    scheme: "msteams",
    hosts: ["teams.microsoft.com"],
    toAppURL(url) {
      // Teams deep links (meetings, chats, channels, messages) live under /l/;
      // the app takes them with the origin replaced by msteams:.
      if (!url.pathname.startsWith("/l/")) {
        return null;
      }
      return `msteams:${url.pathname}${url.search}${url.hash}`;
    },
  },
  {
    id: "slack",
    name: "Slack",
    scheme: "slack",
    hosts: ["app.slack.com"],
    toAppURL(url) {
      const [section, team, channel] = url.pathname.split("/").slice(1);
      if (section !== "client" || !/^[TE][A-Z0-9]+$/.test(team ?? "")) {
        return null;
      }
      if (channel && /^[CDG][A-Z0-9]+$/.test(channel)) {
        return `slack://channel?${new URLSearchParams({ team, id: channel })}`;
      }
      return `slack://open?${new URLSearchParams({ team })}`;
    },
  },
  {
    id: "telegram",
    name: "Telegram",
    scheme: "tg",
    matchHost: host =>
      ["t.me", "telegram.me", "telegram.dog"].includes(host) ||
      /^[a-z][a-z0-9_]{3,31}\.t\.me$/i.test(host),
    toAppURL(url) {
      // <username>.t.me is t.me/<username>.
      const subdomain = url.host.match(/^([^.]+)\.t\.me$/i)?.[1];
      const parts = url.pathname.split("/").slice(1).filter(Boolean);
      if (subdomain) {
        parts.unshift(subdomain);
      }
      const [first, second, third, fourth] = parts;
      if (!first) {
        return null;
      }
      if (first === "joinchat" && second) {
        return `tg://join?${telegramQuery({ invite: second }, url)}`;
      }
      if (first.startsWith("+") && first.length > 1) {
        const rest = first.slice(1);
        return /^\d+$/.test(rest)
          ? `tg://resolve?${telegramQuery({ phone: rest }, url)}`
          : `tg://join?${telegramQuery({ invite: rest }, url)}`;
      }
      if ((first === "addstickers" || first === "addemoji") && second) {
        return `tg://${first}?${telegramQuery({ set: second }, url)}`;
      }
      if (first === "share") {
        return url.searchParams.has("url")
          ? `tg://msg_url?${telegramQuery({}, url)}`
          : null;
      }
      if (first === "proxy" || first === "socks") {
        return url.searchParams.has("server")
          ? `tg://${first}?${telegramQuery({}, url)}`
          : null;
      }
      if (first === "c" && /^\d+$/.test(second ?? "")) {
        // c/<channel>/<post> or c/<channel>/<topic>/<post>
        const post = fourth ?? third;
        if (!/^\d+$/.test(post ?? "")) {
          return null;
        }
        const base = { channel: second, post };
        if (fourth) {
          base.thread = third;
        }
        return `tg://privatepost?${telegramQuery(base, url)}`;
      }
      // s/<username> is the channel's web preview.
      const [name, post, threadPost] =
        first === "s" ? [second, third, fourth] : [first, second, third];
      if (
        !TELEGRAM_USERNAME.test(name ?? "") ||
        (first !== "s" && TELEGRAM_RESERVED.has(name.toLowerCase()))
      ) {
        return null;
      }
      const base = { domain: name };
      if (threadPost && /^\d+$/.test(post) && /^\d+$/.test(threadPost)) {
        base.thread = post;
        base.post = threadPost;
      } else if (post && /^\d+$/.test(post)) {
        base.post = post;
      } else if (post) {
        // A bot's mini app: t.me/<bot>/<app>.
        base.appname = post;
      }
      return `tg://resolve?${telegramQuery(base, url)}`;
    },
  },
  {
    id: "notion",
    name: "Notion",
    scheme: "notion",
    hosts: ["www.notion.so", "notion.so"],
    toAppURL(url) {
      // Workspace pages end in the page's 32-hex id; the rest is the
      // marketing site and sign-in.
      const last = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
      if (!/(^|-)[0-9a-f]{32}$/i.test(last)) {
        return null;
      }
      return `notion://www.notion.so${url.pathname}${url.search}${url.hash}`;
    },
  },
  {
    id: "linear",
    name: "Linear",
    scheme: "linear",
    hosts: ["linear.app"],
    toAppURL(url) {
      const [workspace, section] = url.pathname.split("/").slice(1);
      if (!workspace || !LINEAR_SECTIONS.has(section)) {
        return null;
      }
      return `linear://${url.pathname.slice(1)}${url.search}${url.hash}`;
    },
  },
  {
    id: "spotify",
    name: "Spotify",
    scheme: "spotify",
    hosts: ["open.spotify.com"],
    toAppURL(url) {
      const parts = url.pathname.split("/").filter(Boolean);
      // Localized links: /intl-de/track/<id>.
      if (parts[0]?.startsWith("intl-")) {
        parts.shift();
      }
      const [type, id] = parts;
      if (!SPOTIFY_TYPES.has(type) || !/^[A-Za-z0-9]+$/.test(id ?? "")) {
        return null;
      }
      return `spotify:${type}:${id}`;
    },
  },
  {
    id: "discord",
    name: "Discord",
    scheme: "discord",
    hosts: ["discord.com", "discordapp.com", "discord.gg"],
    toAppURL(url) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.host === "discord.gg") {
        return parts.length === 1 ? `discord://-/invite/${parts[0]}` : null;
      }
      if (parts[0] === "invite" && parts.length === 2) {
        return `discord://-/invite/${parts[1]}`;
      }
      if (parts[0] === "channels" && parts.length >= 2) {
        return `discord://-/${parts.join("/")}`;
      }
      return null;
    },
  },
  {
    id: "ktalk",
    name: "Толк",
    scheme: "ktalk",
    // The hosts Толк trusts for ktalk:// links (its main process: *.ktalk.ru,
    // *.ktalk.kz and talk.skbkontur.ru); ktalk.ru itself is the product site.
    matchHost: host =>
      /^[a-z0-9-]+\.ktalk\.(ru|kz)$/i.test(host) ||
      host === "talk.skbkontur.ru",
    toAppURL(url) {
      if (KTALK_SERVICE_PATHS.test(url.pathname)) {
        return null;
      }
      // Толк turns ktalk://<host>/<path> back into https://<host>/<path>.
      return `ktalk://${url.host}${url.pathname}${url.search}${url.hash}`;
    },
  },
  {
    id: "telemost",
    name: "Яндекс Телемост",
    scheme: "telemost",
    hosts: ["telemost.yandex.ru", "telemost.yandex.com", "telemost.360.yandex.ru"],
    toAppURL(url) {
      // The meeting page itself opens telemost://<meeting URL>, unless the
      // link asks to stay on the web (skip_app=1).
      const match = url.pathname.match(/^\/j\/(\d+)\/?$/);
      if (!match || url.searchParams.get("skip_app") === "1") {
        return null;
      }
      return `telemost://${url.origin}/j/${match[1]}`;
    },
  },
  {
    id: "yandex-music",
    name: "Яндекс Музыка",
    scheme: "yandexmusic",
    matchHost: host => /^music\.yandex\.(ru|com|by|kz|uz)$/.test(host),
    toAppURL(url) {
      // The app opens yandexmusic://<path> as its own /<path>.
      const section = url.pathname.split("/")[1];
      if (!YANDEX_MUSIC_SECTIONS.has(section)) {
        return null;
      }
      return `yandexmusic://${url.pathname.slice(1)}${url.search}`;
    },
  },
];

/**
 * @param {URL} aURL
 * @param {Array<object>} [aApps]
 * @returns {object | null} The app whose site this is, whether or not it can
 *   open this page.
 */
export function findAppForSite(aURL, aApps = OPEN_IN_APP_APPS) {
  if (aURL.protocol !== "https:" && aURL.protocol !== "http:") {
    return null;
  }
  const host = aURL.hostname.toLowerCase();
  return (
    aApps.find(app => app.hosts?.includes(host) || app.matchHost?.(host)) ??
    null
  );
}

/**
 * @param {URL} aURL
 * @param {Array<object>} [aApps]
 * @returns {{app: object, appURL: string} | null} The app that opens this
 *   page, and the URL to open it with.
 */
export function findAppLink(aURL, aApps = OPEN_IN_APP_APPS) {
  const app = findAppForSite(aURL, aApps);
  if (!app) {
    return null;
  }
  const appURL = app.toAppURL(aURL);
  return appURL ? { app, appURL } : null;
}

/** Per-app choice, the value of zen.open-in-app.app.<id>. */
export const MODE_ALWAYS = "always";
export const MODE_ASK = "ask";
export const MODE_NEVER = "never";
export const MODES = [MODE_ALWAYS, MODE_ASK, MODE_NEVER];

/**
 * Decides what a navigation that targets an app's page does.
 *
 * @param {object} nav
 * @param {boolean} nav.enabled - zen.open-in-app.enabled.
 * @param {{app: object, appURL: string} | null} nav.link - findAppLink().
 * @param {boolean} nav.topLevel - The tab's own document, not a frame in it.
 * @param {boolean} nav.inTab - Loads in a tab of a browser window (not a
 *   Glance preview, a sidebar panel, or an agent's pane).
 * @param {boolean} nav.pinned - The tab is pinned or essential.
 * @param {boolean} nav.historyLoad - Back/forward, a reload, or a session
 *   restore of a page already shown here.
 * @param {boolean} nav.keptHere - The user chose to open this page in the
 *   browser (once, or in this tab before).
 * @param {boolean} nav.optionHeld - ⌥ Option is held: open in the browser.
 * @param {boolean} nav.fromSameApp - The tab already shows a page of this app's
 *   site in the browser; following its links stays in the browser.
 * @param {boolean} nav.userInitiated - Typed, opened from the browser's own UI
 *   or another app (system principal), a click (user activation), or the
 *   first load of a new tab. Pages navigating by themselves stay.
 * @param {() => boolean} nav.isInstalled - Asked last: whether the OS has an
 *   app for the scheme.
 * @param {string} nav.mode - The app's setting (MODES).
 * @returns {{action: "app" | "ask" | "browser", reason: string}}
 */
export function decideNavigation(nav) {
  const browser = reason => ({ action: "browser", reason });
  if (!nav.enabled) {
    return browser("disabled");
  }
  if (!nav.link) {
    return browser("no-app");
  }
  if (!nav.topLevel) {
    return browser("subframe");
  }
  if (!nav.inTab) {
    return browser("not-a-tab");
  }
  if (nav.pinned) {
    return browser("pinned");
  }
  if (nav.historyLoad) {
    return browser("history");
  }
  if (nav.keptHere) {
    return browser("kept-here");
  }
  if (nav.optionHeld) {
    return browser("option-held");
  }
  if (nav.fromSameApp) {
    return browser("same-app");
  }
  if (!nav.userInitiated) {
    return browser("not-user-initiated");
  }
  if (nav.mode === MODE_NEVER) {
    return browser("never");
  }
  if (!nav.isInstalled()) {
    return browser("not-installed");
  }
  return { action: nav.mode === MODE_ASK ? "ask" : "app", reason: nav.mode };
}
