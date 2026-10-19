/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com"
);
const PAGE_URL = ROOT + "file_tab_lifecycle_form.html";

// A time after every test tab's timeout has passed.
function later() {
  return Date.now() + gZenTabUnloader.timeoutMs + 60 * 1000;
}

async function addLoadedTab(url = PAGE_URL) {
  const tab = BrowserTestUtils.addTab(gBrowser, url);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  return tab;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.tab-unloader.enabled", true],
      ["zen.tab-unloader.timeout-minutes", 20],
      ["zen.tab-unloader.unload-pinned", false],
    ],
  });
});

add_task(async function test_unloads_idle_tabs_and_keeps_exclusions() {
  const idle = await addLoadedTab();
  const pinned = await addLoadedTab();
  gBrowser.pinTab(pinned);
  const audio = await addLoadedTab();
  audio.toggleAttribute("soundplaying", true);
  const form = await addLoadedTab();
  await SpecialPowers.spawn(form.linkedBrowser, [], () => {
    content.document.getElementById("field").setUserInput("unsaved");
  });
  const active = await addLoadedTab();
  gBrowser.selectedTab = active;

  Assert.equal(gZenTabUnloader.protectionReason(idle), "recent");
  Assert.equal(gZenTabUnloader.protectionReason(idle, later()), null);
  Assert.equal(gZenTabUnloader.protectionReason(pinned, later()), "pinned");
  Assert.equal(gZenTabUnloader.protectionReason(audio, later()), "media");
  Assert.equal(gZenTabUnloader.protectionReason(active, later()), "visible");

  const unloaded = await gZenTabUnloader.sweep(later());

  Assert.ok(unloaded.includes(idle), "The idle tab was unloaded");
  Assert.ok(
    idle.hasAttribute("pending") && !idle.linkedPanel,
    "The idle tab has no browser and is pending"
  );
  Assert.equal(
    gZenTabLoadQueue.getLoadStateTooltip(idle),
    "Not loaded — select to load",
    "The unloaded tab says so in its tooltip"
  );
  for (const [tab, name] of [
    [pinned, "pinned"],
    [audio, "audio"],
    [form, "form input"],
    [active, "active"],
  ]) {
    Assert.ok(!unloaded.includes(tab), `The ${name} tab was not unloaded`);
    Assert.ok(tab.linkedPanel, `The ${name} tab keeps its browser`);
  }

  await SpecialPowers.pushPrefEnv({
    set: [["zen.tab-unloader.unload-pinned", true]],
  });
  const second = await gZenTabUnloader.sweep(later());
  Assert.ok(second.includes(pinned), "unload-pinned allows unloading pinned");
  await SpecialPowers.popPrefEnv();

  audio.removeAttribute("soundplaying");
  for (const tab of [idle, pinned, audio, form, active]) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_disabled_unloader_does_nothing() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.tab-unloader.enabled", false]],
  });
  const idle = await addLoadedTab();
  const unloaded = await gZenTabUnloader.sweep(later());
  Assert.deepEqual(unloaded, [], "Nothing is unloaded when disabled");
  Assert.ok(idle.linkedPanel, "The tab keeps its browser");
  BrowserTestUtils.removeTab(idle);
  await SpecialPowers.popPrefEnv();
});
