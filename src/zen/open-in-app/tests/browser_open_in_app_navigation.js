/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Navigations through the real browser: which loads are handed to the app,
// what the tab does afterwards, and what stays in the browser. A fake app
// claims https://example.org/app/... (the test server serves example.org);
// LaunchServices is replaced by a recorder, so no real app opens.

const { ZenOpenInAppService } = ChromeUtils.importESModule(
  "resource:///modules/zen/openinapp/ZenOpenInApp.sys.mjs"
);
const { PromptTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromptTestUtils.sys.mjs"
);

const PAGE =
  "https://example.com/browser/zen/open-in-app/tests/file_open_in_app_page.html";
const SITE_PAGE =
  "https://example.org/browser/zen/open-in-app/tests/file_open_in_app_page.html?second";
const APP_PAGE = "https://example.org/app/room-1";
const APP_URL = "zentest://app/room-1";

const FAKE_APP = {
  id: "zentest",
  name: "Zen Test App",
  scheme: "zentest",
  hosts: ["example.org"],
  toAppURL: url =>
    url.pathname.startsWith("/app/")
      ? `zentest://${url.pathname.slice(1)}`
      : null,
};

let gLaunched = [];
let gInstalled = true;

add_setup(async function () {
  const { apps, isInstalled, launch, appName } = ZenOpenInAppService;
  ZenOpenInAppService.apps = [...apps, FAKE_APP];
  ZenOpenInAppService.isInstalled = app => app === FAKE_APP && gInstalled;
  ZenOpenInAppService.launch = appURL => {
    gLaunched.push(appURL);
    return true;
  };
  ZenOpenInAppService.appName = app => app.name;
  registerCleanupFunction(() => {
    Object.assign(ZenOpenInAppService, { apps, isInstalled, launch, appName });
    Services.prefs.clearUserPref("zen.open-in-app.app.zentest");
  });
});

function reset() {
  gLaunched = [];
  gInstalled = true;
  Services.prefs.clearUserPref("zen.open-in-app.app.zentest");
}

function systemPrincipal() {
  return Services.scriptSecurityManager.getSystemPrincipal();
}

async function launched(count = 1) {
  await TestUtils.waitForCondition(
    () => gLaunched.length >= count,
    "the app was launched"
  );
  // Let the deferred tab clean-up run.
  await new Promise(resolve => setTimeout(resolve, 50));
}

async function clickLink(browser, id) {
  await BrowserTestUtils.synthesizeMouseAtCenter(`#${id}`, {}, browser);
}

add_task(async function test_new_tab_is_handed_off_and_closes() {
  reset();
  const tabsBefore = gBrowser.tabs.length;
  // As a link from another app or from the embedder (Ombra) opens.
  const tab = gBrowser.addTab(APP_PAGE, {
    triggeringPrincipal: systemPrincipal(),
  });
  await launched();
  Assert.deepEqual(gLaunched, [APP_URL], "the app got its URL");
  await TestUtils.waitForCondition(() => !tab.isConnected, "tab closed");
  is(gBrowser.tabs.length, tabsBefore, "no blank tab is left behind");
});

add_task(async function test_link_click_keeps_the_page() {
  reset();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await clickLink(browser, "app-link");
    await launched();
    Assert.deepEqual(gLaunched, [APP_URL], "the click went to the app");
    is(browser.currentURI.spec, PAGE, "the tab stays on its page");
    ok(gBrowser.getTabForBrowser(browser).isConnected, "the tab stays");
  });
});

add_task(async function test_typed_url_in_existing_tab() {
  reset();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    gURLBar.focus();
    gURLBar.value = APP_PAGE;
    EventUtils.synthesizeKey("KEY_Enter");
    await launched();
    Assert.deepEqual(gLaunched, [APP_URL], "the typed URL went to the app");
    is(browser.currentURI.spec, PAGE, "the tab stays on its page");
  });
});

add_task(async function test_iframe_and_page_navigation_stay() {
  reset();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    // A frame showing the app's page is the page's business.
    await SpecialPowers.spawn(browser, [APP_PAGE], async src => {
      const frame = content.document.createElement("iframe");
      const loaded = new Promise(resolve =>
        frame.addEventListener("load", resolve, { once: true })
      );
      frame.src = src;
      content.document.body.append(frame);
      await loaded;
    });
    // A page sending itself there without a click (the page's own script:
    // code run through SpecialPowers would navigate as the system).
    const loaded = BrowserTestUtils.browserLoaded(browser, false, APP_PAGE);
    await SpecialPowers.spawn(browser, [APP_PAGE], url => {
      const script = content.document.createElement("script");
      script.textContent = `setTimeout(() => (location.href = ${JSON.stringify(url)}), 0);`;
      content.document.body.append(script);
    });
    await loaded;
    Assert.deepEqual(gLaunched, [], "neither went to the app");
  });
});

add_task(async function test_not_installed_and_never_stay() {
  for (const setUp of [
    () => (gInstalled = false),
    () => Services.prefs.setStringPref("zen.open-in-app.app.zentest", "never"),
  ]) {
    reset();
    setUp();
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      const loaded = BrowserTestUtils.browserLoaded(browser, false, APP_PAGE);
      await clickLink(browser, "app-link");
      await loaded;
      Assert.deepEqual(gLaunched, [], "the page loaded in the browser");
    });
  }
});

add_task(async function test_option_click_stays_and_history_stays() {
  reset();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    EventUtils.synthesizeKey("KEY_Alt", { type: "keydown", altKey: true });
    const loaded = BrowserTestUtils.browserLoaded(browser, false, APP_PAGE);
    await clickLink(browser, "app-link");
    await loaded;
    EventUtils.synthesizeKey("KEY_Alt", { type: "keyup" });
    Assert.deepEqual(gLaunched, [], "⌥ kept the link in the browser");

    // Back, forward and reload of the page kept here stay here.
    let shown = BrowserTestUtils.waitForLocationChange(gBrowser, PAGE);
    browser.goBack();
    await shown;
    shown = BrowserTestUtils.waitForLocationChange(gBrowser, APP_PAGE);
    browser.goForward();
    await shown;
    const reloaded = BrowserTestUtils.browserLoaded(browser, false, APP_PAGE);
    browser.reload();
    await reloaded;
    Assert.deepEqual(gLaunched, [], "history loads stayed in the browser");
  });
});

add_task(async function test_same_site_links_stay() {
  reset();
  await BrowserTestUtils.withNewTab(SITE_PAGE, async browser => {
    // The tab already shows the app's site in the browser.
    const loaded = BrowserTestUtils.browserLoaded(browser, false, APP_PAGE);
    await clickLink(browser, "app-link");
    await loaded;
    Assert.deepEqual(gLaunched, [], "links within the app's site stay");
  });
});

add_task(async function test_after_back_navigation_links_still_hand_off() {
  reset();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    let loaded = BrowserTestUtils.browserLoaded(browser, false, SITE_PAGE);
    await clickLink(browser, "site-link");
    await loaded;
    const shown = BrowserTestUtils.waitForLocationChange(gBrowser, PAGE);
    browser.goBack();
    await shown;
    await clickLink(browser, "app-link");
    await launched();
    Assert.deepEqual(gLaunched, [APP_URL], "a normal load after going back");
  });
});

add_task(async function test_open_in_browser_once() {
  reset();
  ZenOpenInAppService.openHere(APP_PAGE);
  const tab = gBrowser.addTab(APP_PAGE, {
    triggeringPrincipal: systemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, APP_PAGE);
  Assert.deepEqual(gLaunched, [], "Open Link in Browser loads it here");
  BrowserTestUtils.removeTab(tab);

  // Only once: the next link goes to the app again.
  const next = gBrowser.addTab(APP_PAGE, {
    triggeringPrincipal: systemPrincipal(),
  });
  await launched();
  await TestUtils.waitForCondition(() => !next.isConnected, "tab closed");
});

add_task(async function test_context_menu_item() {
  reset();
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const menu = document.getElementById("contentAreaContextMenu");
    const item = document.getElementById("context-openlink-inbrowser");
    ok(item, "the menu item exists");
    for (const [id, shown] of [
      ["app-link", true],
      ["site-link", false],
    ]) {
      const popupShown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
      await BrowserTestUtils.synthesizeMouseAtCenter(
        `#${id}`,
        { type: "contextmenu", button: 2 },
        browser
      );
      await popupShown;
      is(!item.hidden, shown, `Open Link in Browser on ${id}`);
      if (!shown) {
        const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
        menu.hidePopup();
        await hidden;
        continue;
      }
      const newTab = BrowserTestUtils.waitForNewTab(gBrowser, APP_PAGE, true);
      const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
      menu.activateItem(item);
      await hidden;
      BrowserTestUtils.removeTab(await newTab);
    }
    Assert.deepEqual(gLaunched, [], "the menu item kept it in the browser");
  });
});

add_task(async function test_ask() {
  for (const [button, remember, launches, mode] of [
    [0, false, 1, null],
    [1, false, 0, null],
    [0, true, 1, "always"],
    [1, true, 0, "never"],
  ]) {
    reset();
    Services.prefs.setStringPref("zen.open-in-app.app.zentest", "ask");
    await BrowserTestUtils.withNewTab(PAGE, async browser => {
      // The checkbox is clicked (PromptTestUtils' checkboxState sets it
      // without the command event the dialog reads it on).
      const prompt = PromptTestUtils.waitForPrompt(browser, {
        modalType: Services.prompt.MODAL_TYPE_TAB,
        promptType: "confirmEx",
      }).then(dialog => {
        if (remember) {
          dialog.ui.checkbox.click();
        }
        return PromptTestUtils.handlePrompt(dialog, {
          buttonNumClick: button,
        });
      });
      const loaded = launches
        ? null
        : BrowserTestUtils.browserLoaded(browser, false, APP_PAGE);
      await clickLink(browser, "app-link");
      await prompt;
      if (launches) {
        await launched();
        is(browser.currentURI.spec, PAGE, "the tab stays on its page");
      } else {
        await loaded;
      }
      is(gLaunched.length, launches, `button ${button}: ${launches} launch`);
      is(
        Services.prefs.getStringPref("zen.open-in-app.app.zentest"),
        mode ?? "ask",
        "the choice is remembered only when asked to"
      );
    });
  }
});

add_task(async function test_pinned_and_restored_tabs_stay() {
  reset();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  gBrowser.pinTab(tab);
  const loaded = BrowserTestUtils.browserLoaded(browser, false, APP_PAGE);
  BrowserTestUtils.startLoadingURIString(browser, APP_PAGE);
  await loaded;
  Assert.deepEqual(gLaunched, [], "a pinned tab keeps its page");
  gBrowser.unpinTab(tab);
  BrowserTestUtils.removeTab(tab);

  // A session restore puts the page back where it was.
  const restored = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const done = BrowserTestUtils.waitForEvent(restored, "SSTabRestored");
  SessionStore.setTabState(
    restored,
    JSON.stringify({
      entries: [
        {
          url: APP_PAGE,
          triggeringPrincipal_base64: E10SUtils.SERIALIZED_SYSTEMPRINCIPAL,
        },
      ],
    })
  );
  gBrowser.selectedTab = restored;
  await done;
  is(restored.linkedBrowser.currentURI.spec, APP_PAGE, "the page is back");
  Assert.deepEqual(gLaunched, [], "a restored tab keeps its page");
  BrowserTestUtils.removeTab(restored);
});
