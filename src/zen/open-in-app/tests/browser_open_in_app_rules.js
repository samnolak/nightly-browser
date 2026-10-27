/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Which site URLs each known app opens (and with what app URL), and what a
// navigation to one does: ZenOpenInAppRules.sys.mjs on its own.

const { findAppLink, decideNavigation, OPEN_IN_APP_APPS } =
  ChromeUtils.importESModule(
    "resource:///modules/zen/openinapp/ZenOpenInAppRules.sys.mjs"
  );

// [site URL, app id, app URL] — app URL null: the site is the app's, but the
// page stays in the browser.
const LINKS = [
  // Figma: files, boards, prototypes and the file browser; not marketing.
  [
    "https://www.figma.com/design/AbC123/Name?node-id=1-2",
    "figma",
    "figma://design/AbC123/Name?node-id=1-2",
  ],
  ["https://figma.com/file/AbC123/Name", "figma", "figma://file/AbC123/Name"],
  ["https://www.figma.com/board/Key/Jam", "figma", "figma://board/Key/Jam"],
  ["https://www.figma.com/proto/Key/P", "figma", "figma://proto/Key/P"],
  ["https://www.figma.com/files/recent", "figma", "figma://files/recent"],
  ["https://www.figma.com/pricing/", "figma", null],
  ["https://www.figma.com/design/Key/N?openInBrowser=1", "figma", null],
  ["https://www.figma.com/file/Key/image/abc", "figma", null],
  // Zoom: meeting and webinar joins, with the password; not the web client.
  [
    "https://us02web.zoom.us/j/81234567890?pwd=SeCrEt",
    "zoom",
    "zoommtg://us02web.zoom.us/join?action=join&confno=81234567890&pwd=SeCrEt",
  ],
  [
    "https://zoom.us/w/912345678",
    "zoom",
    "zoommtg://zoom.us/join?action=join&confno=912345678",
  ],
  ["https://zoom.us/wc/join/81234567890", "zoom", null],
  ["https://zoom.us/my/someone", "zoom", null],
  ["https://zoom.us/", "zoom", null],
  // Teams: deep links under /l/.
  [
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d",
    "teams",
    "msteams:/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d",
  ],
  ["https://teams.microsoft.com/v2/", "teams", null],
  // Slack: the web client's team and channel.
  [
    "https://app.slack.com/client/T0123ABC/C0456DEF",
    "slack",
    "slack://channel?team=T0123ABC&id=C0456DEF",
  ],
  [
    "https://app.slack.com/client/T0123ABC",
    "slack",
    "slack://open?team=T0123ABC",
  ],
  ["https://app.slack.com/signin", "slack", null],
  // Telegram: t.me as Telegram's own tg:// translation.
  ["https://t.me/durov", "telegram", "tg://resolve?domain=durov"],
  ["https://t.me/durov/123", "telegram", "tg://resolve?domain=durov&post=123"],
  [
    "https://t.me/some_group/5/77",
    "telegram",
    "tg://resolve?domain=some_group&thread=5&post=77",
  ],
  [
    "https://t.me/mybot?start=abc",
    "telegram",
    "tg://resolve?domain=mybot&start=abc",
  ],
  ["https://t.me/s/durov", "telegram", "tg://resolve?domain=durov"],
  ["https://t.me/+AbCdEf123", "telegram", "tg://join?invite=AbCdEf123"],
  ["https://t.me/+79991234567", "telegram", "tg://resolve?phone=79991234567"],
  ["https://t.me/joinchat/XyZ", "telegram", "tg://join?invite=XyZ"],
  [
    "https://t.me/c/1234567/89",
    "telegram",
    "tg://privatepost?channel=1234567&post=89",
  ],
  [
    "https://t.me/addstickers/Animals",
    "telegram",
    "tg://addstickers?set=Animals",
  ],
  [
    "https://t.me/share/url?url=https%3A%2F%2Fexample.com",
    "telegram",
    "tg://msg_url?url=https%3A%2F%2Fexample.com",
  ],
  ["https://durov.t.me/", "telegram", "tg://resolve?domain=durov"],
  ["https://t.me/", "telegram", null],
  ["https://t.me/iv?url=x", "telegram", null],
  // Notion: workspace pages (32-hex id).
  [
    "https://www.notion.so/acme/Roadmap-0123456789abcdef0123456789abcdef",
    "notion",
    "notion://www.notion.so/acme/Roadmap-0123456789abcdef0123456789abcdef",
  ],
  ["https://www.notion.so/product", "notion", null],
  // Linear: workspace sections.
  [
    "https://linear.app/acme/issue/ENG-12/fix-it",
    "linear",
    "linear://acme/issue/ENG-12/fix-it",
  ],
  ["https://linear.app/pricing", "linear", null],
  // Spotify.
  [
    "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x",
    "spotify",
    "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
  ],
  [
    "https://open.spotify.com/intl-de/album/1A2B3C",
    "spotify",
    "spotify:album:1A2B3C",
  ],
  ["https://open.spotify.com/", "spotify", null],
  // Discord.
  ["https://discord.gg/abcDEF", "discord", "discord://-/invite/abcDEF"],
  [
    "https://discord.com/channels/123/456/789",
    "discord",
    "discord://-/channels/123/456/789",
  ],
  ["https://discord.com/download", "discord", null],
  // Толк: its spaces' pages, as the app maps ktalk:// back to https://.
  [
    "https://example.ktalk.ru/abcdefgh",
    "ktalk",
    "ktalk://example.ktalk.ru/abcdefgh",
  ],
  [
    "https://space.ktalk.kz/room?x=1#y",
    "ktalk",
    "ktalk://space.ktalk.kz/room?x=1#y",
  ],
  ["https://talk.skbkontur.ru/abc", "ktalk", "ktalk://talk.skbkontur.ru/abc"],
  ["https://example.ktalk.ru/system/dist/v2/", "ktalk", null],
  ["https://example.ktalk.ru/api/info", "ktalk", null],
  // Яндекс Телемост: meetings, as its page opens them.
  [
    "https://telemost.yandex.ru/j/04167590587220",
    "telemost",
    "telemost://https://telemost.yandex.ru/j/04167590587220",
  ],
  ["https://telemost.yandex.ru/j/04167590587220?skip_app=1", "telemost", null],
  ["https://telemost.yandex.ru/", "telemost", null],
  // Яндекс Музыка.
  [
    "https://music.yandex.ru/album/123/track/456",
    "yandex-music",
    "yandexmusic://album/123/track/456",
  ],
  ["https://music.yandex.ru/pay", "yandex-music", null],
];

add_task(async function test_known_links() {
  for (const [site, id, expected] of LINKS) {
    const link = findAppLink(new URL(site));
    is(link?.appURL ?? null, expected, `${site} -> ${expected}`);
    if (expected) {
      is(link.app.id, id, `${site} belongs to ${id}`);
      // What ZenOpenInApp launches must be a URL Gecko can parse.
      ok(Services.io.newURI(expected), `${expected} parses`);
    }
  }
});

add_task(async function test_other_sites_and_schemes() {
  for (const site of [
    "https://example.com/j/81234567890",
    "https://notzoom.us/j/81234567890",
    "https://ktalk.ru/",
    "https://evil.com/?u=https://t.me/durov",
    "ftp://t.me/durov",
    "https://figma.com.evil.com/file/Key/Name",
  ]) {
    is(findAppLink(new URL(site)), null, `${site} is no app's`);
  }
});

add_task(async function test_every_app_is_described() {
  const ids = new Set();
  for (const app of OPEN_IN_APP_APPS) {
    ok(app.id && !ids.has(app.id), `${app.id} is unique`);
    ids.add(app.id);
    ok(app.name && app.scheme, `${app.id} has a name and a scheme`);
    ok(app.hosts || app.matchHost, `${app.id} has hosts`);
  }
});

const LINK = findAppLink(new URL("https://example.ktalk.ru/room"));

function nav(overrides = {}) {
  return {
    enabled: true,
    link: LINK,
    topLevel: true,
    inTab: true,
    pinned: false,
    historyLoad: false,
    keptHere: false,
    optionHeld: false,
    fromSameApp: false,
    userInitiated: true,
    mode: "always",
    isInstalled: () => true,
    ...overrides,
  };
}

add_task(async function test_decisions() {
  const cases = [
    [{}, "app", "always"],
    [{ mode: "ask" }, "ask", "ask"],
    [{ mode: "never" }, "browser", "never"],
    [{ mode: "bogus" }, "app", "bogus"],
    [{ enabled: false }, "browser", "disabled"],
    [{ link: null }, "browser", "no-app"],
    [{ topLevel: false }, "browser", "subframe"],
    [{ inTab: false }, "browser", "not-a-tab"],
    [{ pinned: true }, "browser", "pinned"],
    [{ historyLoad: true }, "browser", "history"],
    [{ keptHere: true }, "browser", "kept-here"],
    [{ optionHeld: true }, "browser", "option-held"],
    [{ fromSameApp: true }, "browser", "same-app"],
    [{ userInitiated: false }, "browser", "not-user-initiated"],
    [{ isInstalled: () => false }, "browser", "not-installed"],
  ];
  for (const [overrides, action, reason] of cases) {
    const decision = decideNavigation(nav(overrides));
    is(decision.action, action, `${JSON.stringify(overrides)}: ${action}`);
    is(decision.reason, reason, `${JSON.stringify(overrides)}: ${reason}`);
  }
});

add_task(async function test_installed_is_asked_last() {
  let asked = 0;
  const isInstalled = () => {
    asked++;
    return true;
  };
  decideNavigation(nav({ topLevel: false, isInstalled }));
  decideNavigation(nav({ mode: "never", isInstalled }));
  is(asked, 0, "LaunchServices is not asked for loads that stay anyway");
  decideNavigation(nav({ isInstalled }));
  is(asked, 1, "asked for a hand-off");
});
