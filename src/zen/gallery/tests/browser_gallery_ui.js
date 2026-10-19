/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { GalleryCommands, assertGalleryWindow } = ChromeUtils.importESModule(
  "resource:///modules/ZenGalleryUI.sys.mjs"
);
const { ZenGalleryStore } = ChromeUtils.importESModule(
  "resource:///modules/ZenGalleryStore.sys.mjs"
);

add_task(async function privileged_about_registration_and_origin_boundary() {
  const about = Cc[
    "@mozilla.org/network/protocol/about;1?what=gallery"
  ].getService(Ci.nsIAboutModule);
  const flags = about.getURIFlags(Services.io.newURI("about:gallery"));
  ok(
    flags & Ci.nsIAboutModule.ALLOW_SCRIPT,
    "Gallery permits its packaged script"
  );
  ok(
    flags & Ci.nsIAboutModule.IS_SECURE_CHROME_UI,
    "Gallery is secure chrome UI"
  );
  ok(
    !(flags & Ci.nsIAboutModule.URI_SAFE_FOR_UNTRUSTED_CONTENT),
    "Gallery is never a content-safe about page"
  );
  ok(
    !(flags & Ci.nsIAboutModule.URI_CAN_LOAD_IN_CHILD),
    "Gallery cannot run in a content process"
  );
  ok(
    !(flags & Ci.nsIAboutModule.URI_MUST_LOAD_IN_CHILD),
    "Gallery does not require a child process"
  );

  Assert.throws(
    () => assertGalleryWindow(window),
    /trusted top-level/,
    "Even system browser chrome is not the gallery document"
  );
  const lookalike = {
    document: {
      documentURI: "about:gallery",
      nodePrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    },
  };
  lookalike.top = lookalike;
  lookalike.document.defaultView = lookalike;
  Assert.throws(
    () => assertGalleryWindow(lookalike),
    /trusted top-level/,
    "A forged object with URI and principal fields is not a native gallery window"
  );
  await Assert.rejects(
    GalleryCommands.run(window, "unlock"),
    /trusted top-level/,
    "The unlock path validates the calling document before invoking OS authentication"
  );
  Assert.throws(
    () => GalleryCommands.observe(window, () => {}),
    /trusted top-level/,
    "State subscriptions are restricted to the gallery too"
  );
});

add_task(async function gallery_is_locked_without_implicit_authentication() {
  await ZenGalleryStore.lock();
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:gallery" },
    async browser => {
      ok(!browser.isRemoteBrowser, "The gallery is native parent-process UI");
      const gallery = browser.contentWindow;
      await TestUtils.waitForCondition(
        () =>
          gallery.document
            .getElementById("status")
            ?.textContent.includes("Gallery locked"),
        "Packaged gallery script initializes the locked screen"
      );
      ok(
        gallery.document.nodePrincipal.isSystemPrincipal,
        "The actual about document has system principal"
      );
      is(
        assertGalleryWindow(gallery),
        window,
        "Only the real top-level gallery resolves its browser window"
      );
      const nested = gallery.document.createElement("iframe");
      gallery.document.body.appendChild(nested);
      Assert.throws(
        () => assertGalleryWindow(nested.contentWindow),
        /trusted top-level/,
        "An embedded native document cannot borrow gallery authority"
      );
      nested.remove();
      ok(ZenGalleryStore.locked, "Opening about:gallery never unlocks storage");
      ok(
        gallery.document.getElementById("gallery").hidden,
        "Private controls are hidden while locked"
      );
      ok(
        !gallery.document.getElementById("locked-screen").hidden,
        "Explicit unlock UI is present"
      );
      is(
        gallery.document.getElementById("text").maxLength,
        512,
        "The search field enforces the store's query limit"
      );
      is(
        (await GalleryCommands.run(gallery, "state")).locked,
        true,
        "State exposes no plaintext data"
      );
      for (const action of [
        "query",
        "bytes",
        "folders",
        "settings",
        "update",
        "remove",
        "export",
        "copyImage",
        "copyLink",
        "open",
        "capture",
        "chooseWatchFolder",
        "setSettings",
        "activity",
      ]) {
        await Assert.rejects(
          GalleryCommands.run(gallery, action, {}),
          /locked/,
          `${action} rejects before any privileged side effect while locked`
        );
      }
      is(
        gallery.document.querySelectorAll("img[src]").length,
        0,
        "Locked UI has no decoded image sources"
      );
    }
  );
});

add_task(async function native_lock_notification_clears_every_private_view() {
  await ZenGalleryStore.lock();
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:gallery" },
    async browser => {
      const gallery = browser.contentWindow;
      const document = gallery.document;
      await TestUtils.waitForCondition(() =>
        document
          .getElementById("status")
          ?.textContent.includes("Gallery locked")
      );

      // Exercise the real observer and DOM cleanup, without replacing the store,
      // bypassing OS authentication, or writing any plaintext fixture to disk.
      document.getElementById("metadata").textContent =
        "private captured title";
      document.getElementById("note").value = "private note";
      document.getElementById("viewer-title").textContent = "private source";
      document.getElementById("text").value = "private search";
      document.getElementById("bulk-tags").value = "private tag";
      document.getElementById("folder-name").value = "private folder";
      document.getElementById("watch-path").textContent =
        "/private/screenshot/folder";
      document.getElementById("masonry").textContent =
        "private thumbnail title";
      const png = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII="
        ),
        character => character.charCodeAt(0)
      );
      const imageURL = gallery.URL.createObjectURL(
        new gallery.Blob([png], { type: "image/png" })
      );
      document.getElementById("full-image").src = imageURL;
      document.getElementById("viewer").showModal();
      Services.obs.notifyObservers(null, "zen-gallery-state", "locked");
      gallery.URL.revokeObjectURL(imageURL);

      ok(
        !document.getElementById("viewer").open,
        "Lock closes the large viewer synchronously"
      );
      is(
        document.getElementById("metadata").textContent,
        "",
        "Lock clears metadata"
      );
      is(
        document.getElementById("viewer-title").textContent,
        "",
        "Lock clears viewer title"
      );
      is(
        document.getElementById("masonry").childElementCount,
        0,
        "Lock removes virtualized cards"
      );
      is(
        document.getElementById("masonry").textContent,
        "",
        "Lock removes card text"
      );
      for (const id of ["note", "text", "bulk-tags", "folder-name"]) {
        is(document.getElementById(id).value, "", `Lock clears ${id}`);
      }
      is(
        document.getElementById("watch-path").textContent,
        "",
        "Lock clears the system screenshot path"
      );
      ok(
        !document.getElementById("full-image").hasAttribute("src"),
        "Lock detaches full-image decode"
      );
      ok(
        document.getElementById("gallery").hidden,
        "Lock hides gallery controls"
      );
    }
  );
});

add_task(async function library_entry_opens_native_gallery() {
  await SpecialPowers.pushPrefEnv({ set: [["zen.library.enabled", true]] });
  ok(
    !document.getElementById("zen-gallery-button"),
    "The sidebar footer has no gallery button"
  );

  const library = document.querySelector("zen-library");
  const ZenLibrary = customElements.get("zen-library");
  ZenLibrary.animateProgress(1);
  await TestUtils.waitForCondition(
    () => library.querySelector('.zen-library-tab[data-action="gallery"]'),
    "Opening the library renders its gallery entry"
  );
  const entry = library.querySelector(
    '.zen-library-tab[data-action="gallery"]'
  );
  is(entry.getAttribute("role"), "button", "The entry is exposed as a button");
  await document.l10n.translateFragment(entry);
  is(
    entry.querySelector("label").textContent,
    "Gallery",
    "The entry is labelled Gallery"
  );
  ok(entry.getAttribute("title"), "The entry has a localized tooltip");

  entry.click();
  await TestUtils.waitForCondition(
    () => gBrowser.selectedBrowser.currentURI.spec === "about:gallery",
    "The library entry selects the registered gallery, including when it reuses a blank tab"
  );
  await TestUtils.waitForCondition(
    () => !ZenLibrary.isLibraryOpen,
    "Opening the gallery closes the library"
  );
  const tab = gBrowser.selectedTab;
  try {
    is(
      tab.linkedBrowser.currentURI.spec,
      "about:gallery",
      "The library entry opens the real registered page"
    );
    ok(
      !tab.linkedBrowser.isRemoteBrowser,
      "The library entry does not open a web imitation of the gallery"
    );

    ZenLibrary.animateProgress(1);
    await TestUtils.waitForCondition(
      () => ZenLibrary.isLibraryOpen,
      "The library reopens"
    );
    const tabCount = gBrowser.tabs.length;
    entry.focus();
    EventUtils.synthesizeKey("KEY_Enter", {}, window);
    await TestUtils.waitForCondition(
      () => !ZenLibrary.isLibraryOpen,
      "Enter on the focused entry closes the library even when the gallery tab is already open"
    );
    is(gBrowser.tabs.length, tabCount, "An open gallery tab is reused");
    is(gBrowser.selectedTab, tab, "The open gallery tab stays selected");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
