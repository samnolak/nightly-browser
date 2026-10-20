/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Closing a tab from its close button in a long sidebar list must leave the
// sidebar where the user is looking: the scroll position stays when the
// closed tab is not the selected one, or when the tab selected in its place
// is already in view. Only a selection outside the view scrolls, and only as
// far as it takes to show it.

// Each case waits out real close animations and smooth scrolls.
requestLongerTimeout(3);

const TAB_COUNT = 45;

function scrollbox() {
  return gZenWorkspaces.activeScrollbox;
}

function scrollTop() {
  return scrollbox().scrollbox.scrollTop;
}

// Waits out the close animation, the deferred sidebar updates and any smooth
// scroll: the position must hold still for a while.
async function settle() {
  /* eslint-disable-next-line mozilla/no-arbitrary-setTimeout */
  await new Promise(resolve => setTimeout(resolve, 150));
  let last = scrollTop();
  let still = 0;
  while (still < 10) {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const now = scrollTop();
    still = now == last ? still + 1 : 0;
    last = now;
  }
}

function viewRect() {
  return scrollbox().scrollbox.getBoundingClientRect();
}

function isInView(element) {
  const view = viewRect();
  const rect = element.getBoundingClientRect();
  return (
    rect.height > 0 &&
    rect.top >= view.top - 1 &&
    rect.bottom <= view.bottom + 1
  );
}

// Scrolls so that `element` sits in the middle of the view.
async function scrollToMiddle(element) {
  const view = viewRect();
  const rect = element.getBoundingClientRect();
  scrollbox().scrollbox.scrollTo({
    top: scrollTop() + rect.top - view.top - (view.height - rect.height) / 2,
    behavior: "instant",
  });
  await settle();
  ok(isInView(element), `${element.label} is in view after scrolling to it`);
}

async function select(tab) {
  gBrowser.selectedTab = tab;
  await settle();
}

async function clickButton(tab, className) {
  const button = tab.querySelector(`.${className}`);
  // The button shows on hover, which the test pointer does not give it.
  button.style.setProperty("display", "block", "important");
  button.style.setProperty("visibility", "visible", "important");
  ok(isInView(button), `The ${className} of ${tab.label} is in view`);
  EventUtils.synthesizeMouseAtCenter(button, { type: "mousemove" });
  EventUtils.synthesizeMouseAtCenter(button, {});
  await settle();
  button.style.removeProperty("display");
  button.style.removeProperty("visibility");
}

async function closeFromButton(tab) {
  await clickButton(tab, "tab-close-button");
  await TestUtils.waitForCondition(
    () => !tab.isConnected,
    `${tab.label} is removed`
  );
  await settle();
}

function addTabs(count, prefix) {
  const tabs = [];
  for (let i = 0; i < count; i++) {
    const tab = BrowserTestUtils.addTab(
      gBrowser,
      `data:text/plain,${prefix}${i}`,
      { skipAnimation: true }
    );
    tab.label = `${prefix}${i}`;
    tabs.push(tab);
  }
  return tabs;
}

// The sidebar as a user has it: smooth scrolling and the close animation,
// which Zen's testing mode turns off. New tabs open at the top, so tabs[0]
// is the lowest of the list.
async function withLongList(callback) {
  const originalTab = gBrowser.selectedTab;
  const tabs = addTabs(TAB_COUNT, "t");
  const smoothScroll = scrollbox().smoothScroll;
  scrollbox().smoothScroll = true;
  const testing = gZenUIManager.testingEnabled;
  gZenUIManager.testingEnabled = false;
  const extra = [];
  try {
    await settle();
    ok(scrollbox().overflowing, "The sidebar overflows");
    await callback(tabs, extra);
  } finally {
    gZenUIManager.testingEnabled = testing;
    scrollbox().smoothScroll = smoothScroll;
    gBrowser.selectedTab = originalTab;
    for (const item of extra) {
      if (!item.isConnected) {
        continue;
      }
      if (gBrowser.isTabGroup(item)) {
        const removed = BrowserTestUtils.waitForEvent(item, "TabGroupRemoved");
        item.delete();
        await removed;
      } else {
        BrowserTestUtils.removeTab(item);
      }
    }
    for (const tab of tabs) {
      if (tab.isConnected) {
        BrowserTestUtils.removeTab(tab);
      }
    }
    scrollbox().scrollbox.scrollTo({ top: 0, behavior: "instant" });
    await settle();
  }
}

function assertKept(before, what) {
  Assert.less(
    Math.abs(scrollTop() - before),
    1,
    `${what}: the scroll position stays (${before} -> ${scrollTop()})`
  );
}

function assertRevealed(tab, what) {
  is(gBrowser.selectedTab, tab, `${what}: ${tab.label} is selected`);
  ok(isInView(tab), `${what}: ${tab.label} is scrolled into view`);
  const view = viewRect();
  const rect = tab.getBoundingClientRect();
  Assert.less(
    Math.min(
      Math.abs(rect.top - view.top),
      Math.abs(rect.bottom - view.bottom)
    ),
    1,
    `${what}: the view scrolls only as far as it takes to show ${tab.label}`
  );
}

async function checkNotSelected(tabs) {
  await select(tabs[44]);
  await scrollToMiddle(tabs[30]);
  ok(!isInView(tabs[44]), "The selected tab is out of view");
  const before = scrollTop();
  await closeFromButton(tabs[30]);
  is(gBrowser.selectedTab, tabs[44], "The selection stays");
  assertKept(before, "Closing a tab that is not selected");
}

async function checkSelectedNextInView(tabs) {
  await scrollToMiddle(tabs[30]);
  await select(tabs[0]);
  // Recently used, in view: the one above and the one below.
  for (const next of [tabs[32], tabs[28]]) {
    await select(next);
    const closing = next == tabs[32] ? tabs[30] : tabs[29];
    await select(closing);
    ok(isInView(next), `${next.label} is in view`);
    const before = scrollTop();
    await closeFromButton(closing);
    is(gBrowser.selectedTab, next, `${next.label} is selected`);
    assertKept(before, `Closing the selected tab next to ${next.label}`);
  }
}

async function checkSelectedNextOutOfView(tabs) {
  // Recently used, out of view: below the closed tab, then above it.
  for (const [next, closing] of [
    [tabs[2], tabs[30]],
    [tabs[44], tabs[29]],
  ]) {
    await select(next);
    await scrollToMiddle(closing);
    await select(closing);
    ok(!isInView(next), `${next.label} is out of view`);
    await closeFromButton(closing);
    assertRevealed(next, `Closing the selected tab before ${next.label}`);
  }
}

add_task(async function test_close_not_selected() {
  await withLongList(checkNotSelected);
});

add_task(async function test_close_selected_next_in_view() {
  await withLongList(checkSelectedNextInView);
});

add_task(async function test_close_selected_next_out_of_view() {
  await withLongList(checkSelectedNextOutOfView);
});

// The window Ombra embeds is the same browser window, marked zen-embedded.
add_task(async function test_close_embedded() {
  const root = document.documentElement;
  root.setAttribute("zen-embedded", "true");
  try {
    await withLongList(checkNotSelected);
    await withLongList(checkSelectedNextInView);
    await withLongList(checkSelectedNextOutOfView);
  } finally {
    root.removeAttribute("zen-embedded");
  }
});

add_task(async function test_close_in_folders() {
  await withLongList(async (tabs, extra) => {
    // Folders hold pinned tabs, above the others: a long folder, then a
    // collapsed one, then the rest of the list.
    const folder = gZenFolders.createFolder(tabs.slice(10, 40), {
      label: "Long",
    });
    extra.push(folder);
    const collapsed = gZenFolders.createFolder(tabs.slice(40, 44), {
      label: "Collapsed",
    });
    extra.push(collapsed);
    collapsed.collapsed = true;
    await settle();

    await select(tabs[0]);
    await scrollToMiddle(tabs[30]);
    let before = scrollTop();
    await closeFromButton(tabs[30]);
    is(gBrowser.selectedTab, tabs[0], "The selection stays");
    assertKept(before, "Closing a folder tab that is not selected");

    await select(tabs[28]);
    await select(tabs[26]);
    await scrollToMiddle(tabs[26]);
    before = scrollTop();
    await closeFromButton(tabs[26]);
    is(gBrowser.selectedTab, tabs[28], "The recently used tab is selected");
    assertKept(before, "Closing the selected folder tab");

    // The recently used tab is in the collapsed folder, out of view: the
    // folder shows it, and the view goes just far enough to see it.
    await select(tabs[41]);
    await select(tabs[12]);
    await scrollToMiddle(tabs[12]);
    ok(!isInView(tabs[41]), "The collapsed folder's tab is out of view");
    await closeFromButton(tabs[12]);
    assertRevealed(tabs[41], "Selecting a tab of a collapsed folder");

    // And the other way: from the collapsed folder to a tab out of view.
    await select(tabs[11]);
    await select(tabs[41]);
    await scrollToMiddle(tabs[41]);
    ok(!isInView(tabs[11]), "The folder's first tab is out of view");
    await closeFromButton(tabs[41]);
    assertRevealed(tabs[11], "Closing the active tab of a collapsed folder");
  });
});

add_task(async function test_close_in_collapsed_folder() {
  await withLongList(async (tabs, extra) => {
    // Pinned tabs above the folder put it in the middle of the list.
    for (const tab of tabs.slice(25, 40)) {
      gBrowser.pinTab(tab);
    }
    const folder = gZenFolders.createFolder(tabs.slice(20, 25), {
      label: "Collapsed",
    });
    extra.push(folder);
    await settle();
    // The folder's active tab stays shown while the folder is collapsed.
    await select(tabs[22]);
    folder.collapsed = true;
    await settle();
    await scrollToMiddle(tabs[22]);
    await select(tabs[19]);
    await select(tabs[22]);
    ok(isInView(tabs[19]), "The recently used tab is in view");
    let before = scrollTop();
    await closeFromButton(tabs[22]);
    is(gBrowser.selectedTab, tabs[19], "The recently used tab is selected");
    assertKept(before, "Closing the active tab of a collapsed folder");

    // A tab that is not selected, right below the collapsed folder.
    await select(tabs[0]);
    await scrollToMiddle(tabs[19]);
    before = scrollTop();
    await closeFromButton(tabs[19]);
    is(gBrowser.selectedTab, tabs[0], "The selection stays");
    assertKept(before, "Closing a tab below a collapsed folder");
  });
});

add_task(async function test_close_with_pinned_and_essentials() {
  await withLongList(async (tabs, extra) => {
    const pinned = addTabs(12, "p");
    extra.push(...pinned);
    for (const tab of pinned) {
      gBrowser.pinTab(tab);
    }
    const essential = addTabs(1, "e")[0];
    extra.push(essential);
    gZenPinnedTabManager.addToEssentials(essential);
    await settle();

    // The selection moves to an essential, which is not in the list.
    await select(essential);
    await select(tabs[30]);
    await scrollToMiddle(tabs[30]);
    let before = scrollTop();
    await closeFromButton(tabs[30]);
    is(gBrowser.selectedTab, essential, "The essential is selected");
    assertKept(before, "Closing the selected tab before an essential");

    // Unloading the selected pinned tab from its button.
    await scrollToMiddle(pinned[8]);
    await select(pinned[9]);
    await select(pinned[8]);
    before = scrollTop();
    await clickButton(pinned[8], "tab-reset-button");
    await TestUtils.waitForCondition(
      () => !pinned[8].selected,
      "The pinned tab is no longer selected"
    );
    await settle();
    is(gBrowser.selectedTab, pinned[9], "The recently used pinned tab");
    assertKept(before, "Unloading the selected pinned tab");

    // Unloading it again, the next one out of view.
    await select(tabs[0]);
    await scrollToMiddle(pinned[2]);
    await select(pinned[2]);
    ok(!isInView(tabs[0]), "The recently used tab is out of view");
    await clickButton(pinned[2], "tab-reset-button");
    await TestUtils.waitForCondition(
      () => !pinned[2].selected,
      "The pinned tab is no longer selected"
    );
    await settle();
    assertRevealed(tabs[0], "Unloading a pinned tab before a tab out of view");

    // A tab below the pinned ones that is not selected.
    await scrollToMiddle(tabs[35]);
    before = scrollTop();
    await closeFromButton(tabs[35]);
    assertKept(before, "Closing a tab below the pinned ones");
  });
});
