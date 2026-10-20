/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.sys.mjs",
});

add_task(async function test_Floating_Urlbar() {
  gURLBar.blur();

  await SimpleTest.promiseFocus(window);
  document.getElementById("Browser:OpenLocation").doCommand();
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    waitForFocus: SimpleTest.waitForFocus,
    value: "https://example.com/",
  });

  ok(
    gURLBar.hasAttribute("zen-floating-urlbar"),
    "URL bar should be in floating mode"
  );
});

add_task(async function test_Click_Shoudnt_FLoat_Urlbar() {
  gURLBar.blur();

  await simulateClick(window);

  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    waitForFocus: SimpleTest.waitForFocus,
    value: "https://example.com/",
  });

  ok(
    !gURLBar.hasAttribute("zen-floating-urlbar"),
    "URL bar should not be in floating mode"
  );
});

add_task(async function test_Floating_Highlight_Everything() {
  gURLBar.blur();

  await SimpleTest.promiseFocus(window);
  await selectWithMouseDrag(2, 5);
  document.getElementById("Browser:OpenLocation").doCommand();

  // Selection range
  Assert.equal(gURLBar.selectionStart, 0, "Selection start should be 0");
  Assert.equal(
    gURLBar.selectionEnd,
    gURLBar.value.length,
    "Selection end should be the length of the value"
  );
});

async function setCompactMode(enabled) {
  if (gZenCompactModeManager.preference !== enabled) {
    gZenCompactModeManager.preference = enabled;
    await gZenCompactModeManager._updateEvent();
  }
}

add_task(async function test_Floating_Urlbar_Collapses_Empty_Slot() {
  const container = document.getElementById("urlbar-container");
  const initialCompact = gZenCompactModeManager.preference;
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:blank"
  );
  registerCleanupFunction(async () => {
    await setCompactMode(initialCompact);
  });

  for (const dark of [0, 1]) {
    await SpecialPowers.pushPrefEnv({
      set: [["ui.systemUsesDarkTheme", dark]],
    });
    for (const compact of [false, true]) {
      await setCompactMode(compact);
      const label = `dark=${dark} compact=${compact}`;
      gURLBar.blur();
      await SimpleTest.promiseFocus(window);
      document.getElementById("Browser:OpenLocation").doCommand();
      await TestUtils.waitForCondition(
        () => gURLBar.hasAttribute("zen-floating-urlbar") && gURLBar.view.isOpen,
        `floating urlbar opens (${label})`
      );

      const style = window.getComputedStyle(container);
      const rect = container.getBoundingClientRect();
      Assert.equal(rect.height, 0, `empty slot has no height (${label})`);
      Assert.equal(rect.width, 0, `empty slot has no width (${label})`);
      Assert.equal(
        style.backgroundColor,
        "rgba(0, 0, 0, 0)",
        `empty slot is transparent (${label})`
      );
      const floating = gURLBar.getBoundingClientRect();
      Assert.greater(floating.width, 0, `floating input visible (${label})`);
      Assert.greater(floating.height, 0, `floating input tall (${label})`);

      EventUtils.synthesizeKey("KEY_Escape");
      EventUtils.synthesizeKey("KEY_Escape");
      gURLBar.blur();
      await TestUtils.waitForCondition(
        () => !gURLBar.hasAttribute("zen-floating-urlbar"),
        `floating urlbar closes (${label})`
      );
      Assert.notEqual(
        window.getComputedStyle(container).height,
        "0px",
        `slot restored after close (${label})`
      );
    }
    await SpecialPowers.popPrefEnv();
  }

  BrowserTestUtils.removeTab(tab);
  await setCompactMode(initialCompact);
});
