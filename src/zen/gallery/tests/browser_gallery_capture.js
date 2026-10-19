/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { ZenGalleryCapture } = ChromeUtils.importESModule(
  "resource:///modules/ZenGalleryCapture.sys.mjs"
);
const { ZenGalleryStore } = ChromeUtils.importESModule(
  "resource:///modules/ZenGalleryStore.sys.mjs"
);

add_setup(async function () {
  await ZenGalleryStore.lock();
  ZenGalleryCapture.startup(window);
  registerCleanupFunction(() => ZenGalleryStore.lock());
});

add_task(async function capture_never_implicitly_unlocks() {
  await BrowserTestUtils.withNewTab("https://example.com/", async browser => {
    for (const mode of ["area", "element", "visible", "full"]) {
      await Assert.rejects(
        ZenGalleryCapture.capture(browser, mode),
        /Unlock/,
        `${mode} requires an explicit unlock`
      );
    }
    Assert.ok(
      ZenGalleryStore.locked,
      "All capture entry points leave storage locked"
    );
  });
});

add_task(async function metadata_and_synthetic_drag_are_unprivileged() {
  await BrowserTestUtils.withNewTab("https://example.com/", async browser => {
    await SpecialPowers.spawn(browser, [], () => {
      const image = content.document.createElement("img");
      image.id = "gallery-forged-drag";
      content.document.body.append(image);
      const meta = content.document.createElement("meta");
      meta.setAttribute("property", "og:image");
      meta.content = "file:///private/gallery-secret.png";
      content.document.head.append(meta);
      const favicon = content.document.createElement("link");
      favicon.rel = "icon";
      favicon.href =
        "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>";
      content.document.head.append(favicon);
      image.dispatchEvent(
        new content.DragEvent("dragstart", { bubbles: true })
      );
    });
    const actor =
      browser.browsingContext.currentWindowGlobal.getActor("ZenGalleryCapture");
    const metadata = await actor.sendQuery("Gallery:Metadata");
    Assert.equal(
      metadata.origin,
      "https://example.com",
      "Metadata is bound to the real page"
    );
    Assert.equal(
      metadata.pageMeta.ogImage,
      "",
      "Privileged image metadata URLs are removed"
    );
    Assert.equal(metadata.favicon, "", "Non-HTTP favicon data is not retained");
    await Assert.rejects(
      actor.sendQuery("Gallery:Drop", { token: "forged" }),
      /expired/,
      "A synthetic drag cannot mint an image-import capability"
    );
    Assert.ok(
      !document.getElementById("zen-gallery-drop-zone"),
      "Untrusted content cannot open the chrome save target"
    );
    ZenGalleryCapture.receive(actor, browser, {
      name: "Gallery:Region",
      data: {
        token: "forged",
        region: { left: 0, top: 0, right: 20, bottom: 20, devicePixelRatio: 1 },
        metadata: {},
        source: "area",
      },
    });
    Assert.ok(
      ZenGalleryStore.locked,
      "An unsolicited region neither unlocks nor starts an import"
    );
  });
});

add_task(async function native_selection_has_no_plaintext_actions() {
  await BrowserTestUtils.withNewTab("https://example.com/", async browser => {
    const actor =
      browser.browsingContext.currentWindowGlobal.getActor("ZenGalleryCapture");
    try {
      await actor.sendQuery("Gallery:Start", {
        token: "native-test",
        mode: "element",
      });
      await SpecialPowers.spawn(browser, [], async () => {
        const child = content.windowGlobalChild.getActor("ZenGalleryCapture");
        await ContentTaskUtils.waitForCondition(
          () => child.overlay.initialized,
          "Native selection overlay initialized"
        );
        Assert.equal(
          child.overlay.copyButton.style.display,
          "none",
          "Native clipboard action is hidden"
        );
        Assert.equal(
          child.overlay.downloadButton.textContent,
          "Save to gallery",
          "Native selection exposes only encrypted save"
        );
        Assert.equal(
          child.overlay.downloadButton.getAttribute("aria-label"),
          "Save to gallery",
          "Encrypted action is accessible"
        );
        child.overlay.copySelectedRegion();
        Assert.ok(
          !child.overlay.initialized,
          "The native copy event completes gallery selection, never exports"
        );
      });
      Assert.ok(
        ZenGalleryStore.locked,
        "Child selection without a parent capability cannot access storage"
      );
      const visible = await actor.sendQuery("Gallery:Bounds", {
        mode: "visible",
      });
      const full = await actor.sendQuery("Gallery:Bounds", { mode: "full" });
      Assert.greater(
        visible.region.width,
        0,
        "Native visible bounds are populated"
      );
      Assert.greater(
        full.region.height,
        0,
        "Native full-page bounds are populated"
      );
      await SpecialPowers.spawn(browser, [], () => {
        Assert.ok(
          !content.windowGlobalChild.getActor("ZenGalleryCapture").overlay
            .initialized,
          "Bounds queries remove the native overlay"
        );
      });
    } finally {
      actor.sendAsyncMessage("Gallery:Cancel");
    }
  });
});

add_task(async function gallery_overlay_events_are_isolated_and_trusted() {
  await BrowserTestUtils.withNewTab("https://example.com/", async browser => {
    const actor =
      browser.browsingContext.currentWindowGlobal.getActor("ZenGalleryCapture");
    try {
      for (const action of [
        "downloadSelectedRegion",
        "copySelectedRegion",
        "cancelOverlay",
      ]) {
        await actor.sendQuery("Gallery:Start", {
          token: `event-test-${action}`,
          mode: "area",
        });
        await SpecialPowers.spawn(browser, [action], overlayAction => {
          const child = content.windowGlobalChild.getActor("ZenGalleryCapture");
          Assert.equal(
            child.overlay.eventPrefix,
            "Gallery",
            "Gallery owns a separate chrome event namespace"
          );
          const script = content.document.createElement("script");
          script.textContent = `
            for (const type of ["Gallery:Download", "Gallery:Copy", "Gallery:Close"]) {
              const event = new CustomEvent(type, {
                bubbles: true, detail: { region: { left: 0, top: 0, right: 20, bottom: 20 } },
              });
              document.documentElement.setAttribute("data-gallery-event-trusted", String(event.isTrusted));
              window.dispatchEvent(event);
            }
          `;
          content.document.body.append(script);
          script.remove();
          Assert.equal(
            content.document.documentElement.getAttribute(
              "data-gallery-event-trusted"
            ),
            "false",
            "The forgery originates in page script, not the privileged test sandbox"
          );
          Assert.ok(
            child.overlay.initialized,
            "Untrusted page events cannot save or cancel a gallery capture"
          );
          const nativeEvents = [];
          const handler = child.docShell.chromeEventHandler;
          const recordNative = event => {
            nativeEvents.push(event.type);
            event.stopImmediatePropagation();
          };
          const types = [
            "Screenshots:Download",
            "Screenshots:Copy",
            "Screenshots:Close",
          ];
          for (const type of types) {
            handler.addEventListener(type, recordNative, true);
          }
          try {
            child.overlay[overlayAction]();
            Assert.equal(
              nativeEvents.length,
              0,
              "Gallery actions never reach the plaintext screenshot namespace"
            );
            Assert.ok(
              !child.overlay.initialized,
              "The trusted overlay action reaches the gallery actor"
            );
          } finally {
            for (const type of types) {
              handler.removeEventListener(type, recordNative, true);
            }
          }
        });
        Assert.ok(
          ZenGalleryStore.locked,
          "A child event without a parent capability cannot access storage"
        );
      }
    } finally {
      actor.sendAsyncMessage("Gallery:Cancel");
    }
  });
});
