/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

// Positive coverage for every capture source in an explicitly unlocked
// gallery: area, element, visible, full, system import and drag & drop.

const { ZenGalleryCapture } = ChromeUtils.importESModule(
  "resource:///modules/ZenGalleryCapture.sys.mjs"
);
const { ZenGalleryStore, GalleryStore } = ChromeUtils.importESModule(
  "resource:///modules/ZenGalleryStore.sys.mjs"
);
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs"
);
const { PromptTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromptTestUtils.sys.mjs"
);

const PAGE = "https://example.com/";
const ROOT = PathUtils.join(PathUtils.profileDir, "zen-gallery");

add_setup(async function () {
  // OSKeyStore honors its test-only login pref only on the "default" channel;
  // emulate a local build for this test. Production prefs/code are unchanged.
  const defaults = Services.prefs.getDefaultBranch(null);
  const wasLocked = Services.prefs.prefIsLocked("app.update.channel");
  const originalChannel = defaults.getCharPref("app.update.channel", "");
  Services.prefs.unlockPref("app.update.channel");
  defaults.setCharPref("app.update.channel", "default");
  Assert.ok(
    OSKeyStoreTestUtils.canTestOSKeyStoreLogin(),
    "Test-only OSKeyStore login is available"
  );
  OSKeyStoreTestUtils.setup();
  await SpecialPowers.pushPrefEnv({
    set: [[OSKeyStoreTestUtils.TEST_ONLY_REAUTH, "pass"]],
  });
  ZenGalleryStore.lock();
  await ZenGalleryStore.close();
  await IOUtils.remove(ROOT, { recursive: true, ignoreAbsent: true });
  ZenGalleryCapture.startup(window);
  await ZenGalleryStore.unlock();
  registerCleanupFunction(async () => {
    ZenGalleryStore.lock();
    await ZenGalleryStore.close();
    await IOUtils.remove(ROOT, { recursive: true, ignoreAbsent: true });
    await OSKeyStoreTestUtils.cleanup();
    defaults.setCharPref("app.update.channel", originalChannel);
    if (wasLocked) {
      Services.prefs.lockPref("app.update.channel");
    }
  });
});

function shot(id) {
  return ZenGalleryStore.query({}).items.find(item => item.shotId === id);
}

async function preparePage(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    doc.title = "Gallery capture fixture";
    doc.body.style.margin = "0";
    const target = doc.createElement("div");
    target.id = "gallery-target";
    target.textContent = "Selected words for the gallery";
    target.style.cssText =
      "position:absolute;left:300px;top:200px;width:200px;height:120px;background:rgb(200,40,40);color:white";
    const spacer = doc.createElement("div");
    spacer.style.cssText = "height:3000px";
    doc.body.append(target, spacer);
  });
}

async function mouse(browser, type, x, y) {
  await BrowserTestUtils.synthesizeMouse(":root", x, y, { type }, browser);
}

async function overlayState(browser, state) {
  await SpecialPowers.spawn(browser, [state], async expected => {
    const child = content.windowGlobalChild.getActor("ZenGalleryCapture");
    await ContentTaskUtils.waitForCondition(
      () => child.overlay?.initialized && child.overlay.state === expected,
      `Overlay reaches ${expected}`
    );
  });
}

async function saveSelection(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    content.windowGlobalChild
      .getActor("ZenGalleryCapture")
      .overlay.downloadSelectedRegion();
  });
}

add_task(async function visible_and_full_page_capture() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await preparePage(browser);
    await SpecialPowers.spawn(browser, [], () => {
      const range = content.document.createRange();
      range.selectNodeContents(
        content.document.getElementById("gallery-target")
      );
      content.getSelection().removeAllRanges();
      content.getSelection().addRange(range);
    });
    const viewport = await SpecialPowers.spawn(browser, [], () => ({
      w: content.document.documentElement.clientWidth,
      h: content.document.documentElement.clientHeight,
      dpr: content.devicePixelRatio,
    }));
    const visibleId = await ZenGalleryCapture.capture(browser, "visible");
    const visible = shot(visibleId);
    Assert.equal(
      visible.source,
      "visible",
      "Visible capture records its source"
    );
    Assert.equal(
      visible.url,
      PAGE,
      "Visible capture records the page URL from the parent"
    );
    Assert.equal(
      visible.origin,
      "https://example.com",
      "Visible capture records the origin"
    );
    Assert.equal(
      visible.title,
      "Gallery capture fixture",
      "Visible capture records the title"
    );
    // Native visible bounds exclude scrollbars (documentElement client box).
    Assert.equal(
      visible.width,
      Math.round(viewport.w * viewport.dpr),
      "Visible capture is viewport wide, without scrollbar"
    );
    Assert.equal(
      visible.height,
      Math.round(viewport.h * viewport.dpr),
      "Visible capture is viewport high, without scrollbar"
    );
    Assert.equal(visible.colors.length, 5, "Visible capture has a palette");
    Assert.equal(
      visible.selectionText,
      "Selected words for the gallery",
      "Page selection text is stored"
    );
    Assert.equal(
      ZenGalleryStore.query({ text: "selected words" }).total,
      1,
      "Selection text is searchable"
    );
    Assert.less(
      Math.abs(visible.createdAt - Date.now()),
      60000,
      "Capture time is recorded"
    );

    const fullId = await ZenGalleryCapture.capture(browser, "full");
    const full = shot(fullId);
    Assert.equal(full.source, "full", "Full-page capture records its source");
    Assert.greaterOrEqual(
      full.height,
      Math.round(3000 * viewport.dpr),
      "Full-page capture includes content below the fold"
    );
    Assert.greater(
      full.height,
      visible.height,
      "Full page is taller than the visible area"
    );
    Assert.equal(
      ZenGalleryStore.query({ site: "example.com" }).total,
      2,
      "Domain search finds both captures"
    );
  });
});

add_task(async function area_selection_capture() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await preparePage(browser);
    const dpr = await SpecialPowers.spawn(
      browser,
      [],
      () => content.devicePixelRatio
    );
    const capture = ZenGalleryCapture.capture(browser, "area");
    await overlayState(browser, "crosshairs");
    await mouse(browser, "mousedown", 20, 20);
    await mouse(browser, "mousemove", 120, 80);
    await mouse(browser, "mousemove", 220, 140);
    await mouse(browser, "mouseup", 220, 140);
    await overlayState(browser, "selected");
    await saveSelection(browser);
    const area = shot(await capture);
    Assert.equal(
      area.source,
      "area",
      "Dragged region is stored as an area capture"
    );
    Assert.equal(
      area.width,
      Math.round(200 * dpr),
      "Area width matches the dragged region"
    );
    Assert.equal(
      area.height,
      Math.round(120 * dpr),
      "Area height matches the dragged region"
    );
    Assert.equal(area.url, PAGE, "Area capture keeps the page URL");
  });
});

add_task(async function element_capture() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await preparePage(browser);
    const dpr = await SpecialPowers.spawn(
      browser,
      [],
      () => content.devicePixelRatio
    );
    const capture = ZenGalleryCapture.capture(browser, "element");
    await overlayState(browser, "crosshairs");
    await mouse(browser, "mousemove", 400, 260);
    await SpecialPowers.spawn(browser, [], async () => {
      const overlay =
        content.windowGlobalChild.getActor("ZenGalleryCapture").overlay;
      await ContentTaskUtils.waitForCondition(
        () => overlay.hoverElementRegion.width === 200,
        "Hovered element is highlighted"
      );
    });
    await mouse(browser, "mousedown", 400, 260);
    await mouse(browser, "mouseup", 400, 260);
    await overlayState(browser, "selected");
    await saveSelection(browser);
    const element = shot(await capture);
    Assert.equal(
      element.source,
      "element",
      "Clicked element is stored as an element capture"
    );
    Assert.equal(
      element.selector,
      "#gallery-target",
      "Element capture records the element selector"
    );
    Assert.equal(
      element.width,
      Math.round(200 * dpr),
      "Element capture matches the element width"
    );
    Assert.equal(
      element.height,
      Math.round(120 * dpr),
      "Element capture matches the element height"
    );
    Assert.ok(
      element.colors.includes("#c82828"),
      "Palette contains the element colour"
    );
  });
});

add_task(async function cancelled_selection_saves_nothing() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const before = ZenGalleryStore.query({}).total;
    const capture = ZenGalleryCapture.capture(browser, "area");
    await overlayState(browser, "crosshairs");
    await SpecialPowers.spawn(browser, [], () => {
      content.windowGlobalChild
        .getActor("ZenGalleryCapture")
        .overlay.cancelOverlay();
    });
    await Assert.rejects(
      capture,
      /cancelled/,
      "Cancelling the overlay rejects the capture"
    );
    Assert.equal(
      ZenGalleryStore.query({}).total,
      before,
      "Cancelled selection stores nothing"
    );
  });
});

add_task(async function system_screenshot_import() {
  const folder = PathUtils.join(
    PathUtils.tempDir,
    "zen-gallery-watch-" + Services.uuid.generateUUID().toString().slice(1, 9)
  );
  await IOUtils.makeDirectory(folder);
  try {
    await BrowserTestUtils.withNewTab(PAGE, async () => {
      await ZenGalleryStore.setSettings({ watchFolder: folder });
      await TestUtils.waitForCondition(
        async () => (await ZenGalleryStore.getWatchState())?.initialized,
        "Watcher baseline",
        200,
        100
      );
      const before = ZenGalleryStore.query({ text: "" }).items.filter(
        item => item.source === "system"
      ).length;
      const canvas = new OffscreenCanvas(40, 30);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "rgb(20,120,220)";
      ctx.fillRect(0, 0, 40, 30);
      const png = new Uint8Array(
        await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer()
      );
      const file = PathUtils.join(folder, "Screenshot 1.png");
      const prompt = TestUtils.topicObserved(
        "common-dialog-loaded",
        subject => subject.Dialog?.args.promptType === "confirmEx"
      ).then(([subject]) => {
        Assert.ok(
          subject.Dialog.args.text.includes("Screenshot 1.png"),
          "Import asks whether to delete the named original"
        );
        return PromptTestUtils.handlePrompt(subject.Dialog, {
          buttonNumClick: 0,
        });
      });
      await IOUtils.write(file, png);
      const { lastModified } = await IOUtils.stat(file);
      await prompt;
      await TestUtils.waitForCondition(
        async () => !(await IOUtils.exists(file)),
        "Original deleted after confirmation",
        200,
        100
      );
      const imported = ZenGalleryStore.query({}).items.filter(
        item => item.source === "system"
      );
      Assert.equal(
        imported.length,
        before + 1,
        "System screenshot imported once"
      );
      Assert.equal(
        imported[0].width,
        40,
        "Imported raster dimensions are preserved"
      );
      Assert.equal(
        imported[0].colors[0],
        "#1478dc",
        "Imported palette is computed"
      );
      Assert.equal(
        imported[0].createdAt,
        lastModified,
        "Import time is the file modification time"
      );
      Assert.equal(
        imported[0].url,
        PAGE,
        "Import records the active tab of the focused browser window"
      );
    });
  } finally {
    await ZenGalleryStore.setSettings({ watchFolder: "" });
    await IOUtils.remove(folder, { recursive: true, ignoreAbsent: true });
  }
});

add_task(async function drag_opens_radial_menu_at_the_cursor() {
  const folderId = await ZenGalleryStore.createFolder(
    "Moodboard with a long folder name"
  );
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const actor =
      browser.browsingContext.currentWindowGlobal.getActor("ZenGalleryCapture");
    const x = Math.round(window.innerWidth / 2) + 40;
    const y = Math.round(window.innerHeight / 2) + 20;
    // Simulates the child's Gallery:Drag notification (sent on a trusted
    // dragstart, with its screen point); the drop capability stays in the child.
    ZenGalleryCapture.receive(actor, browser, {
      name: "Gallery:Drag",
      data: {
        token: "drag-token",
        screenX: window.mozInnerScreenX + x,
        screenY: window.mozInnerScreenY + y,
      },
    });
    const zone = await TestUtils.waitForCondition(
      () => document.getElementById("zen-gallery-drop-zone"),
      "Drop zone is shown during drag"
    );
    const rect = zone.getBoundingClientRect();
    Assert.ok(
      rect.width >= window.innerWidth - 1 && rect.height >= window.innerHeight - 1,
      "The zone covers the window"
    );
    Assert.ok(
      getComputedStyle(zone).backdropFilter.includes("blur"),
      "The page blurs under the menu"
    );
    const items = [...zone.querySelectorAll("[data-action]")];
    Assert.deepEqual(
      items.map(item => item.dataset.action),
      ["folder", "new", "cancel"],
      "Folder, New folder and Cancel; no folders before Folder is reached"
    );
    const center = element => {
      const r = element.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    };
    for (const item of items) {
      const [ix, iy] = center(item);
      Assert.less(
        Math.abs(Math.hypot(ix - x, iy - y) - 88),
        2,
        `${item.dataset.action} lies on the ring around the cursor`
      );
    }
    items[0].dispatchEvent(new DragEvent("dragenter", { bubbles: true }));
    const saves = [...zone.querySelectorAll("[data-action=save]")];
    Assert.equal(saves[0].dataset.folderId, "", "The gallery itself comes first");
    Assert.ok(
      saves.some(
        item =>
          item.dataset.folderId === folderId &&
          item.textContent === "Moodboard with a long folder name"
      ),
      "Reaching Folder opens the folders"
    );
    for (const item of saves) {
      const [, iy] = center(item);
      Assert.less(iy, y, "The folders open above the cursor");
    }
    ZenGalleryCapture.receive(actor, browser, { name: "Gallery:DragEnd" });
    Assert.ok(
      !document.getElementById("zen-gallery-drop-zone"),
      "Drop zone hides when the drag ends"
    );
    ZenGalleryCapture.receive(actor, browser, {
      name: "Gallery:Drag",
      data: { token: "drag-token-2" },
    });
    await TestUtils.waitForCondition(
      () => document.getElementById("zen-gallery-drop-zone"),
      "Drop zone shown again"
    );
    ZenGalleryStore.lock();
    Assert.ok(
      !document.getElementById("zen-gallery-drop-zone"),
      "Locking removes the drop zone"
    );
    await ZenGalleryStore.unlock();
  });
});

add_task(async function gallery_unlock_browse_and_lock() {
  ZenGalleryStore.lock();
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:gallery" },
    async browser => {
      const doc = browser.contentWindow.document;
      await TestUtils.waitForCondition(
        () =>
          doc.getElementById("status")?.textContent.includes("Gallery locked"),
        "Locked screen shown"
      );
      ok(
        !doc.getElementById("locked-screen").hidden,
        "Locked screen is visible before authentication"
      );
      doc.getElementById("unlock").click();
      await TestUtils.waitForCondition(
        () => !ZenGalleryStore.locked && !doc.getElementById("gallery").hidden,
        "Unlock button authenticates and reveals the gallery"
      );
      ok(
        doc.getElementById("locked-screen").hidden,
        "Locked screen hides after unlock"
      );
      ok(
        !doc.getElementById("lock").hidden,
        "Lock button is offered while unlocked"
      );
      const total = ZenGalleryStore.query({}).total;
      await TestUtils.waitForCondition(
        () => doc.querySelectorAll("#masonry .shot").length === total,
        "Every capture has a card"
      );
      await TestUtils.waitForCondition(
        () =>
          doc.querySelectorAll("#masonry .shot img[src^='blob:']").length ===
          total,
        "Thumbnails decode from encrypted storage"
      );
      doc.querySelector("#masonry .shot .preview").click();
      await TestUtils.waitForCondition(
        () =>
          doc.getElementById("viewer").open &&
          doc.getElementById("full-image").src.startsWith("blob:"),
        "Viewer opens with the full image"
      );
      ok(
        doc.getElementById("metadata").textContent.includes("example.com"),
        "Viewer shows capture metadata"
      );
      is(
        doc.querySelectorAll("#palette button").length,
        5,
        "Viewer shows the five-colour palette"
      );
      doc.getElementById("text").value = "selected words";
      doc
        .getElementById("text")
        .dispatchEvent(
          new browser.contentWindow.Event("input", { bubbles: true })
        );
      // The visible and full-page captures were both taken while the text was selected.
      await TestUtils.waitForCondition(
        () =>
          doc.getElementById("count").textContent === "2 screenshots" &&
          doc.querySelectorAll("#masonry .shot").length === 2,
        "Search narrows to captures with the selected text"
      );
      doc.getElementById("lock").click();
      await TestUtils.waitForCondition(
        () =>
          ZenGalleryStore.locked && !doc.getElementById("locked-screen").hidden,
        "Lock button locks the store and shows the locked screen"
      );
      ok(!doc.getElementById("viewer").open, "Locking closes the viewer");
      is(
        doc.querySelectorAll("img[src]").length,
        0,
        "Locking detaches every decoded image"
      );
    }
  );
  await ZenGalleryStore.unlock();
});
