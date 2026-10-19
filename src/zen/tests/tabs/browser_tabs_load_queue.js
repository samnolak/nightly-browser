/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const SLOW_URL =
  getRootDirectory(gTestPath).replace(
    "chrome://mochitests/content",
    "https://example.com"
  ) + "file_tab_lifecycle_slow.sjs";
const MAX_CONCURRENT = 2;
const TAB_COUNT = 8;

function openInBackground(count) {
  const urls = Array.from({ length: count }, (_, i) => `${SLOW_URL}?tab${i}`);
  return gBrowser.loadTabs(urls, {
    inBackground: true,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
}

function isLoaded(tab) {
  return (
    !!tab.linkedPanel &&
    !tab.hasAttribute("pending") &&
    !tab.hasAttribute("zen-load-queued") &&
    tab.linkedBrowser.currentURI.spec.startsWith(SLOW_URL)
  );
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.tabs.load-queue.enabled", true],
      ["zen.tabs.load-queue.max-concurrent", MAX_CONCURRENT],
    ],
  });
});

add_task(async function test_queue_limit_and_queued_state_resolves() {
  let maxLoading = 0;
  const sample = () => {
    maxLoading = Math.max(maxLoading, gZenTabLoadQueue.loadingCount);
  };
  const interval = setInterval(sample, 0);
  gBrowser.tabContainer.addEventListener("SSTabRestored", sample);

  const tabs = openInBackground(TAB_COUNT);
  Assert.equal(tabs.length, TAB_COUNT, "All tabs were opened");
  Assert.ok(
    tabs.every(tab => !tab.linkedPanel),
    "Queued tabs are created without a browser"
  );
  Assert.ok(
    tabs.every(tab => tab.hasAttribute("zen-load-queued")),
    "Every bulk-opened tab shows the queued state"
  );
  Assert.ok(
    tabs.at(-1).label.includes("file_tab_lifecycle_slow.sjs"),
    "A queued tab shows its URL instead of a placeholder title"
  );
  Assert.equal(
    gZenTabLoadQueue.getLoadStateTooltip(tabs.at(-1)),
    `Waiting to load (${TAB_COUNT} of ${TAB_COUNT})`,
    "The tooltip explains the queue position"
  );

  await TestUtils.waitForCondition(
    () => tabs.every(isLoaded),
    "Every queued tab loads",
    100,
    300
  );
  clearInterval(interval);
  gBrowser.tabContainer.removeEventListener("SSTabRestored", sample);

  Assert.lessOrEqual(
    maxLoading,
    MAX_CONCURRENT,
    "No more tabs load at once than zen.tabs.load-queue.max-concurrent"
  );
  Assert.greater(maxLoading, 0, "The queue loaded tabs");
  Assert.equal(gZenTabLoadQueue.queuedTabs.length, 0, "The queue is empty");
  Assert.ok(
    tabs.every(tab => !tab.hasAttribute("zen-load-queued")),
    "No tab keeps the queued state"
  );
  Assert.equal(
    gZenTabLoadQueue.getLoadStateTooltip(tabs[0]),
    null,
    "Loaded tabs get no load-state tooltip"
  );

  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_selecting_queued_tab_loads_it() {
  const tabs = openInBackground(TAB_COUNT);
  const last = tabs.at(-1);
  Assert.ok(last.hasAttribute("zen-load-queued"), "The last tab is queued");

  const restored = BrowserTestUtils.waitForEvent(last, "SSTabRestored");
  gBrowser.selectedTab = last;
  Assert.ok(
    !last.hasAttribute("zen-load-queued"),
    "Selecting a queued tab takes it out of the queue"
  );
  await restored;
  Assert.ok(isLoaded(last), "The selected tab loaded");

  await TestUtils.waitForCondition(() => tabs.every(isLoaded));
  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_closing_queued_tab() {
  const tabs = openInBackground(TAB_COUNT);
  const closed = tabs.at(-1);
  BrowserTestUtils.removeTab(closed);
  Assert.ok(
    !gZenTabLoadQueue.queuedTabs.includes(closed),
    "A closed tab leaves the queue"
  );
  const rest = tabs.slice(0, -1);
  await TestUtils.waitForCondition(() => rest.every(isLoaded));
  for (const tab of rest) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_early_inserted_browser_still_loads() {
  const tabs = openInBackground(TAB_COUNT);
  const last = tabs.at(-1);
  // Touching webProgress on a lazy browser inserts it before the queue does.
  void last.linkedBrowser.webProgress;
  Assert.ok(last.linkedPanel, "Reading webProgress inserted the browser");
  Assert.ok(last.hasAttribute("pending"), "The tab is still pending");
  await TestUtils.waitForCondition(
    () => tabs.every(isLoaded),
    "Tabs whose browser was inserted early still load",
    100,
    300
  );
  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_small_batches_are_not_queued() {
  const tabs = openInBackground(MAX_CONCURRENT);
  Assert.ok(
    tabs.every(tab => tab.linkedPanel && !tab.hasAttribute("zen-load-queued")),
    "Opening no more tabs than the limit loads them directly"
  );
  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_queue_disabled() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.tabs.load-queue.enabled", false]],
  });
  const tabs = openInBackground(TAB_COUNT);
  Assert.ok(
    tabs.every(tab => tab.linkedPanel && !tab.hasAttribute("zen-load-queued")),
    "With the queue disabled every tab gets a browser right away"
  );
  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
  await SpecialPowers.popPrefEnv();
});
