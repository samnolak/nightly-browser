/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// B1/B2 through Ombra: the share actions, the dialog, what is sent, the reasons
// when Ombra cannot share, and incoming shares as toasts that open. Ombra is
// replaced by a fake transport (ZenTeamLink.setTransportForTesting); the Mach
// channel itself is checked against a running Ombra (NightlyTeamLink tests).

const { ZenTeamLink, peerRequirement } = ChromeUtils.importESModule(
  "resource:///modules/zen/teams/ZenTeamLink.sys.mjs"
);
const {
  ZenTeamsUI,
  screenshotJpeg,
  MAX_SCREENSHOT_BYTES,
  secretParams,
  stripSecrets,
} = ChromeUtils.importESModule(
  "resource:///modules/zen/teams/ZenTeamsUI.sys.mjs"
);

const DIALOG_URL = "chrome://browser/content/zen-team-share.xhtml";
const TEAM = {
  id: "aa11",
  title: "Team aa11",
  members: [
    { id: "b0b0", name: "Bob" },
    { id: "ca7e", name: "Cate" },
  ],
};
const READY = { ok: true, ready: true, me: "a11ce", teams: [TEAM] };

/** A fake Ombra: answers by op, records the requests. */
function fakeOmbra(answers) {
  const requests = [];
  const inbox = [];
  ZenTeamLink.setTransportForTesting(async request => {
    requests.push(request);
    if (request.op === "inbox") {
      if (inbox.length) {
        return { ok: true, items: inbox.splice(0), now: 0 };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      return { ok: true, items: [], now: 0 };
    }
    const answer = answers[request.op];
    return typeof answer === "function" ? answer(request) : answer;
  });
  return { requests, inbox };
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.window-sync.enabled", false],
      ["zen.teams.inbox-after", "0"],
      ["zen.teams.inbox-skip", ""],
      ["zen.tabs.auto-groups.enabled", true],
      ["zen.tabs.auto-groups.threshold", 4],
      ["zen.tabs.auto-groups.excluded-domains", ""],
      ["zen.tabs.auto-groups.path-rules", ""],
    ],
  });
  registerCleanupFunction(() => {
    ZenTeamLink.stopInbox();
    ZenTeamLink.setTransportForTesting(null);
  });
});

async function openTabMenu(tab) {
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu" });
  await shown;
  return menu;
}

async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
}

async function withTab(url, callback) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  try {
    await callback(tab);
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
}

async function shareThroughDialog(trigger, fill) {
  const dialogOpened = BrowserTestUtils.promiseAlertDialogOpen(
    null,
    DIALOG_URL,
    { isSubDialog: true, callback: async win => fill(win) }
  );
  trigger();
  await dialogOpened;
  // A tab removed while the window-modal dialog is still closing stays the
  // selected tab: every later tab switch then fails, and so does the harness.
  await TestUtils.waitForCondition(
    () => !window.gDialogBox.isOpen,
    "share dialog closed"
  );
}

add_task(async function test_peer_requirement_from_prefs() {
  const HASH = "0123456789abcdef0123456789abcdef01234567";
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.embed.peer-requirement", ""],
      ["zen.embed.peer-cdhash", HASH],
    ],
  });
  is(peerRequirement(), `cdhash H"${HASH}"`, "ad-hoc Ombra: its cdhash");
  for (const bad of ["", HASH.toUpperCase(), HASH.slice(1), `${HASH}" or true`]) {
    Services.prefs.setStringPref("zen.embed.peer-cdhash", bad);
    is(peerRequirement(), "", `no requirement from cdhash ${JSON.stringify(bad)}`);
  }
  Services.prefs.setStringPref("zen.embed.peer-requirement", 'identifier "x"');
  Services.prefs.setStringPref("zen.embed.peer-cdhash", HASH);
  is(peerRequirement(), 'identifier "x"', "a Developer ID requirement wins");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_disabled_with_reason_when_ombra_cannot_share() {
  const cases = [
    [{ ok: false, error: "not-running" }, "open Ombra on this Mac"],
    [{ ok: false, error: "untrusted" }, "could not be verified"],
    [{ ok: true, ready: false, reason: "signed-out" }, "sign in to your team"],
    [{ ok: true, ready: false, reason: "no-team" }, "create or join a team"],
    [
      { ok: true, ready: true, me: "a11ce", teams: [{ ...TEAM, members: [] }] },
      "nobody else is in your team",
    ],
  ];
  await withTab("https://example.com/?reason", async tab => {
    for (const [state, text] of cases) {
      fakeOmbra({ state });
      await ZenTeamLink.state({ fresh: true });
      const menu = await openTabMenu(tab);
      const share = document.getElementById("context-zen-team-share-tab");
      const reason = document.getElementById("tabContextMenu-zen-team-reason");
      await TestUtils.waitForCondition(
        () => !reason.hidden && reason.label.includes(text),
        `reason "${text}" shown`
      );
      ok(share.disabled, `Share Tab is disabled: ${text}`);
      ok(!share.hidden, "Share Tab stays visible");
      await closeMenu(menu);
    }
  });
});

add_task(async function test_share_tab_with_comment_to_one_member() {
  const ombra = fakeOmbra({
    state: READY,
    share: request => ({ ok: true, sent: request.to.length }),
  });
  await withTab("https://example.com/?page=shared&token=s3cret", async tab => {
    const menu = await openTabMenu(tab);
    const share = document.getElementById("context-zen-team-share-tab");
    await TestUtils.waitForCondition(() => !share.disabled, "Share enabled");
    ok(
      document.getElementById("tabContextMenu-zen-team-reason").hidden,
      "No reason while Ombra can share"
    );
    await shareThroughDialog(
      () => menu.activateItem(share),
      async win => {
        const doc = win.document;
        await TestUtils.waitForCondition(
          () => doc.getElementById("zen-team-share-members").children.length,
          "members listed"
        );
        const names = [
          ...doc.getElementById("zen-team-share-members").children,
        ].map(label => label.textContent);
        Assert.deepEqual(names, ["Bob", "Cate"], "Ombra's names listed");
        const warning = doc.getElementById("zen-team-share-secrets");
        await TestUtils.waitForCondition(
          () =>
            !warning.hidden &&
            doc
              .getElementById("zen-team-share-secrets-text")
              .textContent.includes("token"),
          "the secret parameter is named"
        );
        ok(doc.getElementById("zen-team-share-strip").checked, "strip by default");
        doc.getElementById("zen-team-share-comment").value = "Look at this";
        doc.getElementById("zen-team-share-to-members").click();
        const accept = doc.querySelector("dialog").getButton("accept");
        ok(accept.disabled, "Send needs a member when sending to members");
        doc.querySelector("#zen-team-share-members input[value='ca7e']").click();
        ok(!accept.disabled, "Send enabled with a member chosen");
        accept.click();
      }
    );
    const sent = ombra.requests.find(r => r.op === "share");
    Assert.deepEqual(
      sent,
      {
        op: "share",
        team: "aa11",
        to: ["ca7e"],
        item: {
          kind: "link",
          url: "https://example.com/?page=shared",
          title: tab.label,
          comment: "Look at this",
        },
      },
      "Ombra got the page, the comment and the member"
    );
    await TestUtils.waitForCondition(
      () =>
        [...document.querySelectorAll(".zen-toast label")].some(label =>
          label.textContent.includes("Shared with 1 member")
        ),
      "sent toast"
    );
  });
});

add_task(async function test_share_failure_keeps_dialog_open() {
  fakeOmbra({
    state: READY,
    share: { ok: false, error: "failed", detail: "server said no" },
  });
  await withTab("https://example.com/?fails", async tab => {
    const menu = await openTabMenu(tab);
    const share = document.getElementById("context-zen-team-share-tab");
    await TestUtils.waitForCondition(() => !share.disabled);
    await shareThroughDialog(
      () => menu.activateItem(share),
      async win => {
        const doc = win.document;
        await TestUtils.waitForCondition(
          () => doc.getElementById("zen-team-share-members").children.length
        );
        doc.querySelector("dialog").getButton("accept").click();
        const status = doc.getElementById("zen-team-share-status");
        await TestUtils.waitForCondition(
          () => status.textContent.includes("server said no"),
          "error shown in the dialog"
        );
        ok(!win.closed, "dialog stays open");
        doc.querySelector("dialog").getButton("cancel").click();
      }
    );
  });
});

add_task(async function test_secrets_in_the_address_are_flagged_and_stripped() {
  Assert.deepEqual(
    secretParams("https://a.example/cb?code=1&state=2#access_token=3&x=4"),
    ["code", "state", "access_token"],
    "query and fragment parameters"
  );
  is(
    stripSecrets("https://a.example/cb?q=1&api_key=2#id_token=3"),
    "https://a.example/cb?q=1",
    "stripped from the query and the fragment"
  );
  is(
    stripSecrets("https://a.example/doc#section-2"),
    "https://a.example/doc#section-2",
    "an ordinary anchor stays"
  );
});

add_task(async function test_share_auto_group_as_collection_to_everyone() {
  const ombra = fakeOmbra({
    state: READY,
    share: { ok: true, sent: 2 },
  });
  const win = await BrowserTestUtils.openNewBrowserWindow();
  try {
    await TestUtils.waitForCondition(() => win.gZenAutoGroups?._ready);
    const tabs = [];
    for (let i = 0; i < 4; i++) {
      const tab = BrowserTestUtils.addTab(
        win.gBrowser,
        `https://example.com/?auto-share=${i}`
      );
      await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
      tabs.push(tab);
    }
    await TestUtils.waitForCondition(
      () => tabs.every(t => t.group && t.group === tabs[0].group),
      "B1 auto group formed"
    );
    const group = tabs[0].group;
    ok(group.hasAttribute("zen-auto-group"), "it is an auto group");
    const menu = win.document.getElementById("tabContextMenu");
    const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    EventUtils.synthesizeMouseAtCenter(tabs[1], { type: "contextmenu" }, win);
    await shown;
    const share = win.document.getElementById("context-zen-team-share-group");
    await TestUtils.waitForCondition(() => !share.disabled && !share.hidden);
    const opened = BrowserTestUtils.promiseAlertDialogOpen(null, DIALOG_URL, {
      isSubDialog: true,
      callback: async dialog => {
        const doc = dialog.document;
        await TestUtils.waitForCondition(() =>
          doc.getElementById("zen-team-share-what-text").textContent.includes(
            "4 tabs"
          )
        );
        ok(
          doc.getElementById("zen-team-share-to-all").checked,
          "everyone by default"
        );
        doc.querySelector("dialog").getButton("accept").click();
      },
    });
    menu.activateItem(share);
    await opened;
    const sent = ombra.requests.find(r => r.op === "share");
    is(sent.to, "all", "sent to everyone");
    is(sent.item.kind, "collection", "a collection");
    is(sent.item.title, group.label, "named as the group");
    Assert.deepEqual(
      sent.item.links.map(l => l.url),
      group.tabs.map(t => t.linkedBrowser.currentURI.spec),
      "every tab of the group"
    );
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_incoming_link_and_group_toast_and_open() {
  const ombra = fakeOmbra({
    state: READY,
    open: request =>
      request.id === "1111"
        ? {
            ok: true,
            kind: "link",
            url: "https://example.com/?from-bob",
            title: "From Bob",
          }
        : {
            ok: true,
            kind: "collection",
            title: "Refs",
            links: [
              { url: "https://example.com/?ref=1", title: "1" },
              { url: "https://example.org/?ref=2", title: "2" },
            ],
          },
  });
  ZenTeamLink.stopInbox();
  ZenTeamLink.startInbox();
  ombra.inbox.push({
    team: "aa11",
    author: "b0b0",
    authorName: "Bob",
    id: "1111",
    kind: "link",
    createdAt: 1000,
    title: "From Bob",
    url: "https://example.com/?from-bob",
  });
  const toastLabel = () =>
    [...document.querySelectorAll(".zen-toast label")].find(label =>
      label.textContent.includes("Bob shared a link “From Bob”")
    );
  await TestUtils.waitForCondition(toastLabel, "incoming link toast");
  const button = document.getElementById("zen-team-toast-open-link");
  await TestUtils.waitForCondition(() => button.label === "Open");
  const text = button.querySelector(".button-text");
  ok(
    text && text.getBoundingClientRect().width > 0,
    `the Open button shows its label (${text?.value || text?.textContent}, ${text?.getBoundingClientRect().width}px)`
  );
  const tabOpened = BrowserTestUtils.waitForNewTab(
    gBrowser,
    "https://example.com/?from-bob"
  );
  button.doCommand();
  const tab = await tabOpened;
  ok(
    ombra.requests.some(r => r.op === "open" && r.id === "1111"),
    "Open accepts it in Ombra"
  );
  BrowserTestUtils.removeTab(tab);
  is(
    Services.prefs.getStringPref("zen.teams.inbox-after"),
    "1000",
    "announced items are remembered"
  );

  ombra.inbox.push({
    team: "aa11",
    author: "b0b0",
    authorName: "Bob",
    id: "2222",
    kind: "collection",
    createdAt: 1001,
    title: "Refs",
  });
  await TestUtils.waitForCondition(
    () =>
      [...document.querySelectorAll(".zen-toast label")].some(label =>
        label.textContent.includes("Bob shared a collection “Refs”")
      ),
    "incoming group toast"
  );
  const urls = group =>
    group.tabs.map(t => t.linkedBrowser?.currentURI.spec).sort().join(" ");
  document.getElementById("zen-team-toast-open-collection").doCommand();
  const group = await TestUtils.waitForCondition(
    () =>
      gBrowser.tabGroups.find(
        g =>
          g.label === "Refs" &&
          urls(g) === "https://example.com/?ref=1 https://example.org/?ref=2"
      ),
    "the collection opens as a tab group named as shared, with its tabs"
  );
  for (const tab of [...group.tabs]) {
    BrowserTestUtils.removeTab(tab);
  }
  for (const tab of gBrowser.tabs.filter(
    t => t !== gBrowser.tabs[0] && t.linkedBrowser?.currentURI.spec === "about:blank"
  )) {
    BrowserTestUtils.removeTab(tab);
  }
  ZenTeamLink.stopInbox();
});

add_task(async function test_screenshot_fits_in_a_team_item() {
  const canvas = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas"
  );
  canvas.width = 2400;
  canvas.height = 1600;
  const ctx = canvas.getContext("2d");
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = `hsl(${(i * 37) % 360} 80% ${30 + (i % 40)}%)`;
    ctx.fillRect((i * 97) % 2400, (i * 53) % 1600, 40, 40);
  }
  const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  const bytes = new Uint8Array(await png.arrayBuffer());
  Assert.greater(bytes.length, MAX_SCREENSHOT_BYTES, "the PNG is too big as is");
  const jpeg = atob(await screenshotJpeg(window, bytes));
  Assert.lessOrEqual(jpeg.length, MAX_SCREENSHOT_BYTES, "the JPEG fits");
  is(jpeg.charCodeAt(0), 0xff, "a JPEG");
  ok(ZenTeamsUI.forWindow(window), "the window has the team UI");
});
