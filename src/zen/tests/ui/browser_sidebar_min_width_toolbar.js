/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

function insideToolbox(element) {
  const box = gNavToolbox.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.left >= box.left - 0.5 &&
    rect.right <= box.right + 0.5
  );
}

async function dragSplitterTo(width) {
  const splitter = document.getElementById("zen-sidebar-splitter");
  const start = gNavToolbox.getBoundingClientRect().width;
  const rect = splitter.getBoundingClientRect();
  const x = rect.width / 2;
  const y = rect.height / 2;
  EventUtils.synthesizeMouse(splitter, x, y, { type: "mousedown" });
  EventUtils.synthesizeMouse(splitter, x + (width - start) / 2, y, {
    type: "mousemove",
  });
  EventUtils.synthesizeMouse(splitter, x + (width - start), y, {
    type: "mousemove",
  });
  await new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );
  EventUtils.synthesizeMouse(splitter, x + (width - start), y, {
    type: "mouseup",
  });
  await TestUtils.waitForCondition(
    () => !splitter.hasAttribute("zen-resizing"),
    "Resize settles"
  );
}

add_task(async function test_top_buttons_stay_in_sidebar_at_minimum_width() {
  const original = gNavToolbox.getBoundingClientRect().width;
  const min = gZenVerticalTabsManager.getSidebarMinWidth();
  const reload = document.getElementById("stop-reload-button");
  ok(
    insideToolbox(reload),
    "Reload is in the sidebar toolbar at the default width"
  );
  try {
    await dragSplitterTo(min - 40);
    Assert.lessOrEqual(
      Math.abs(gNavToolbox.getBoundingClientRect().width - min),
      1,
      "Dragging below the limit clamps to the minimum width"
    );
    // Overflow is recomputed on the resize the splitter dispatches.
    await TestUtils.waitForCondition(() => {
      const overflowed = reload.getAttribute("overflowedItem") === "true";
      return overflowed || insideToolbox(reload);
    }, "Reload either fits or moves to the overflow menu");
    const target = document.getElementById(
      "zen-sidebar-top-buttons-customization-target"
    );
    for (const child of target.children) {
      const rect = child.getBoundingClientRect();
      if (rect.width) {
        ok(insideToolbox(child), `${child.id} stays inside the sidebar`);
      }
    }
    if (reload.getAttribute("overflowedItem") === "true") {
      const overflowButton = document.getElementById("nav-bar-overflow-button");
      ok(
        insideToolbox(overflowButton),
        "Overflowed reload stays reachable through a visible overflow button in the sidebar"
      );
    } else {
      ok(
        insideToolbox(reload),
        "Reload fits within the sidebar at minimum width"
      );
    }
  } finally {
    await dragSplitterTo(original);
  }
  await TestUtils.waitForCondition(
    () =>
      insideToolbox(reload) && reload.getAttribute("overflowedItem") !== "true",
    "Reload returns to the toolbar at the default width"
  );
  ok(insideToolbox(reload), "Default width keeps reload in the toolbar");
});
