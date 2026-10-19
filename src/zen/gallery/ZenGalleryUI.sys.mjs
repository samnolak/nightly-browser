/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ZenUIComponent } from "resource:///modules/zen/ui/ZenUIComponent.sys.mjs";
import { ZenGalleryStore } from "resource:///modules/ZenGalleryStore.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  ZenGalleryCapture: "resource:///modules/ZenGalleryCapture.sys.mjs",
  ZenTeamLink: "resource:///modules/zen/teams/ZenTeamLink.sys.mjs",
  ZenTeamsUI: "resource:///modules/zen/teams/ZenTeamsUI.sys.mjs",
});

let registered = false;
let lockEpoch = 0;
Services.obs.addObserver((_subject, _topic, state) => {
  if (state === "locked") {
    lockEpoch++;
  }
}, "zen-gallery-state");

export function assertGalleryWindow(window) {
  // Neither a look-alike web document, a chrome-resource direct load, nor a
  // nested frame is an authority to read decrypted data or invoke OS services.
  if (
    !window ||
    Cu.getClassName(window, true) !== "Window" ||
    window.closed ||
    window !== window.top ||
    window.document.defaultView !== window ||
    window.document.documentURI !== "about:gallery" ||
    !window.document.nodePrincipal.isSystemPrincipal ||
    window.browsingContext?.parent
  ) {
    throw new Error(
      "Gallery commands require the trusted top-level about:gallery document"
    );
  }
  const browser = window.browsingContext?.embedderElement;
  if (
    !browser ||
    browser.documentGlobal.document.documentElement.getAttribute(
      "windowtype"
    ) !== "navigator:browser"
  ) {
    throw new Error("Gallery commands require a browser tab");
  }
  return browser.documentGlobal;
}

function assertUnlocked(window, epoch) {
  assertGalleryWindow(window);
  if (ZenGalleryStore.locked || epoch !== lockEpoch) {
    throw new Error("Gallery is locked; unlock it to continue");
  }
}

function confirmPlaintext(window, description) {
  const chromeWindow = assertGalleryWindow(window);
  return Services.prompt.confirm(
    chromeWindow,
    "Leave encrypted gallery?",
    `${description}\n\nThis creates an unencrypted copy outside the gallery. Other applications can read it; locking the gallery will not remove it.`
  );
}

async function selectedShots(ids) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 5000 ||
    ids.some(id => typeof id !== "string")
  ) {
    throw new Error("Select between 1 and 5000 screenshots");
  }
  const wanted = new Set(ids);
  const shots = [];
  for (let offset = 0; ; offset += 500) {
    const result = await ZenGalleryStore.query({ offset, limit: 500 });
    for (const shot of result.items) {
      if (wanted.delete(shot.shotId)) {
        shots.push(shot);
      }
    }
    if (!wanted.size || offset + result.items.length >= result.total) {
      break;
    }
  }
  if (wanted.size) {
    throw new Error("A selected screenshot is no longer available");
  }
  return shots;
}

function openSource(chromeWindow, shot) {
  const uri = Services.io.newURI(shot.url);
  if (!uri.schemeIs("https") && !uri.schemeIs("http")) {
    throw new Error("Only HTTP and HTTPS source pages can be opened");
  }
  if (uri.userPass) {
    throw new Error("Source URLs containing credentials cannot be opened");
  }
  const tab = chromeWindow.gBrowser.addTab(uri.spec, {
    triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}),
  });
  chromeWindow.gBrowser.selectedTab = tab;
  const browser = tab.linkedBrowser;
  let timer;
  const cleanup = () => {
    browser.removeProgressListener(listener);
    chromeWindow.clearTimeout(timer);
  };
  const listener = {
    QueryInterface: ChromeUtils.generateQI([
      "nsIWebProgressListener",
      "nsISupportsWeakReference",
    ]),
    onStateChange(progress, _request, flags) {
      if (
        !progress.isTopLevel ||
        !(flags & Ci.nsIWebProgressListener.STATE_STOP) ||
        !(flags & Ci.nsIWebProgressListener.STATE_IS_WINDOW)
      ) {
        return;
      }
      cleanup();
      // A redirect must never apply captured coordinates to another document.
      if (browser.currentURI.spec === uri.spec) {
        browser.browsingContext.currentWindowGlobal
          ?.getActor("ZenGalleryScroll")
          .sendQuery("Gallery:RestoreScroll", {
            url: uri.spec,
            x: shot.scroll?.x ?? 0,
            y: shot.scroll?.y ?? 0,
          })
          .catch(() =>
            console.warn("Gallery source scroll could not be restored")
          );
      }
    },
    onLocationChange() {},
    onProgressChange() {},
    onStatusChange() {},
    onSecurityChange() {},
    onContentBlockingEvent() {},
  };
  browser.addProgressListener(listener);
  timer = chromeWindow.setTimeout(cleanup, 30000);
}

export const GalleryCommands = {
  observe(window, callback) {
    assertGalleryWindow(window);
    const observer = (_subject, _topic, state) => callback(state);
    Services.obs.addObserver(observer, "zen-gallery-state");
    return () => Services.obs.removeObserver(observer, "zen-gallery-state");
  },

  // eslint-disable-next-line complexity
  async run(window, action, args = {}) {
    const chromeWindow = assertGalleryWindow(window);
    if (action === "state") {
      return { locked: ZenGalleryStore.locked };
    }
    if (action === "unlock") {
      await ZenGalleryStore.unlock();
      assertGalleryWindow(window);
      return undefined;
    }
    if (action === "lock") {
      return ZenGalleryStore.lock();
    }
    const epoch = lockEpoch;
    assertUnlocked(window, epoch);
    let result;
    switch (action) {
      case "activity":
        ZenGalleryStore.activity();
        break;
      case "query":
        result = await ZenGalleryStore.query(args);
        break;
      case "bytes":
        result = await ZenGalleryStore.bytes(args.id, args.kind);
        break;
      case "folders":
        result = await ZenGalleryStore.folders();
        break;
      case "settings":
        result = await ZenGalleryStore.settings();
        break;
      case "update":
        result = await ZenGalleryStore.update(args.ids, args.patch);
        break;
      case "createFolder":
        result = await ZenGalleryStore.createFolder(args.name);
        break;
      case "setSettings":
        // Folder paths can only enter settings through the native picker.
        if (
          Object.keys(args).some(
            key => !["autoTags", "idleMinutes"].includes(key)
          )
        ) {
          throw new Error("Unsupported gallery setting");
        }
        result = await ZenGalleryStore.setSettings(args);
        break;
      case "chooseWatchFolder":
        result = await lazy.ZenGalleryCapture.chooseWatchFolder(chromeWindow);
        break;
      case "disableWatchFolder":
        await lazy.ZenGalleryCapture.disableWatcher();
        break;
      case "remove":
        if (
          Services.prompt.confirm(
            chromeWindow,
            "Delete screenshots?",
            `Permanently delete ${args.ids?.length ?? 0} selected screenshots? This cannot be undone.`
          )
        ) {
          assertUnlocked(window, epoch);
          result = await ZenGalleryStore.remove(args.ids);
        }
        break;
      case "capture": {
        if (!["area", "visible", "full", "element"].includes(args.mode)) {
          throw new Error("Unsupported capture mode");
        }
        const source = chromeWindow.gBrowser.tabs
          .filter(tab => /^https?:\/\//.test(tab.linkedBrowser.currentURI.spec))
          .sort((a, b) => b.lastAccessed - a.lastAccessed)[0];
        if (!source) {
          throw new Error("Open the page to capture in another tab first");
        }
        chromeWindow.gBrowser.selectedTab = source;
        result = await lazy.ZenGalleryCapture.capture(
          source.linkedBrowser,
          args.mode
        );
        break;
      }
      case "open":
      case "copyLink":
      case "copyImage": {
        const [shot] = await selectedShots([args.id]);
        assertUnlocked(window, epoch);
        if (action === "open") {
          openSource(chromeWindow, shot);
        } else if (action === "copyLink") {
          if (
            confirmPlaintext(
              window,
              "Copy the source URL to the system clipboard?"
            )
          ) {
            assertUnlocked(window, epoch);
            Cc["@mozilla.org/widget/clipboardhelper;1"]
              .getService(Ci.nsIClipboardHelper)
              .copyString(shot.url);
          }
        } else if (
          confirmPlaintext(
            window,
            "Copy this screenshot to the system clipboard?"
          )
        ) {
          const bytes = await ZenGalleryStore.bytes(shot.shotId, "image");
          assertUnlocked(window, epoch);
          lazy.BrowserUtils.copyImageToClipboard(
            bytes.byteOffset === 0 &&
              bytes.byteLength === bytes.buffer.byteLength
              ? bytes.buffer
              : bytes.slice().buffer
          );
        }
        break;
      }
      case "teamState": {
        // Whether the screenshot can be shared through Ombra now, and why not.
        const team = await lazy.ZenTeamLink.state();
        result = team.ready
          ? { ready: true }
          : {
              ready: false,
              text: await chromeWindow.document.l10n.formatValue(
                "zen-team-unavailable-toast",
                { reason: team.reason }
              ),
            };
        break;
      }
      case "shareTeam": {
        // The share dialog is the consent for the copy that leaves the gallery
        // (end-to-end encrypted to the chosen team members).
        const [shot] = await selectedShots([args.id]);
        assertUnlocked(window, epoch);
        const bytes = await ZenGalleryStore.bytes(shot.shotId, "image");
        assertUnlocked(window, epoch);
        result =
          (await lazy.ZenTeamsUI.forWindow(chromeWindow)?.shareScreenshot(
            shot,
            bytes
          )) ?? 0;
        break;
      }
      case "export": {
        const shots = await selectedShots(args.ids);
        assertUnlocked(window, epoch);
        const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
          Ci.nsIFilePicker
        );
        picker.init(
          chromeWindow.browsingContext,
          "Export selected screenshots",
          Ci.nsIFilePicker.modeGetFolder
        );
        const choice = await new Promise(resolve => picker.open(resolve));
        assertUnlocked(window, epoch);
        if (
          choice !== Ci.nsIFilePicker.returnOK ||
          !confirmPlaintext(
            window,
            `Export ${shots.length} screenshots and their metadata to ${picker.file.path}?`
          )
        ) {
          return 0;
        }
        assertUnlocked(window, epoch);
        let count = 0;
        for (const shot of shots) {
          const bytes = await ZenGalleryStore.bytes(shot.shotId, "image");
          assertUnlocked(window, epoch);
          const basename = `gallery-${Services.uuid.generateUUID().toString().slice(1, -1)}`;
          await IOUtils.write(
            PathUtils.join(picker.file.path, `${basename}.png`),
            bytes,
            { mode: "create" }
          );
          assertUnlocked(window, epoch);
          await IOUtils.writeUTF8(
            PathUtils.join(picker.file.path, `${basename}.json`),
            JSON.stringify(shot, null, 2),
            { mode: "create" }
          );
          count++;
        }
        result = count;
        break;
      }
      default:
        throw new Error("Unknown gallery command");
    }
    assertUnlocked(window, epoch);
    return result;
  },
};

export class ZenGalleryUI extends ZenUIComponent {
  /**
   * Opens the gallery in a browser window, selecting an existing gallery tab
   * (or reusing a blank one) before opening a new one. The Zen Library's
   * "Gallery" entry is the entry point.
   *
   * @param {Window} window - The browser window to open it in
   */
  static open(window) {
    window.switchToTabHavingURI("about:gallery", true);
  }

  init() {
    if (!registered) {
      ChromeUtils.registerWindowActor("ZenGalleryScroll", {
        child: {
          esModuleURI: "resource:///modules/ZenGalleryScrollChild.sys.mjs",
        },
        matches: ["http://*/*", "https://*/*"],
        allFrames: false,
      });
      registered = true;
    }
    lazy.ZenGalleryCapture.startup(this.window);
  }
}
