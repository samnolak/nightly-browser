/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The embedder's commands for a full browser window it shows
// (OpenBrowserWindow, see ZenEmbedHost.mm). ZenEmbedHost sends
// zen-embed-command ("op\ntext") with the chrome window as subject, as it does
// for zen-embed.js in the chrome-less embed windows; this answers it for
// navigator:browser windows. Navigate opens the URL in a new tab (an empty new
// tab is reused, Zen's empty tab is not); reload, back, forward and stop act on
// the selected tab; close closes the window. zen-embed-browser-window (sent
// once the window shows) marks its document zen-embedded: zen-browser-ui.css
// fits it into the embedder's sheet. zen-embed-stray-window names any other
// browser window opened meanwhile (a page's popup, a link or a tab for a new
// window, a window the session restores): ZenEmbedHost keeps it off screen,
// and its tabs move into the pane's window, which it then closes; a private
// one is only closed (its tabs cannot join a normal window). Only in an
// embedder's runtime (NIGHTLY_EMBED_SERVICE).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  ZenEmbedDialogs: "resource:///actors/ZenEmbedDialogs.sys.mjs",
});

const COMMAND_NAVIGATE = 1;
const COMMAND_RELOAD = 2;
const COMMAND_BACK = 3;
const COMMAND_FORWARD = 4;
const COMMAND_STOP = 5;
const COMMAND_CLOSE = 6;

let gStarted = false;
// The pane windows (zen-embed-browser-window), most recent last.
const gPanes = [];
// Strays that came before any pane window was marked.
const gWaitingStrays = new Set();
// Until the startup's session is restored, a stray is one of its windows: its
// tabs join the pane's window without taking the selection.
let gSessionRestored = false;

export const ZenEmbedBrowser = {
  // browser-before-ui-startup (ZenComponents.manifest): once per process.
  init() {
    if (gStarted || !Services.env.get("NIGHTLY_EMBED_SERVICE")) {
      return;
    }
    gStarted = true;
    Services.obs.addObserver(this, "zen-embed-command");
    Services.obs.addObserver(this, "zen-embed-browser-window");
    Services.obs.addObserver(this, "zen-embed-stray-window");
    Services.obs.addObserver(this, "sessionstore-windows-restored");
  },

  observe(subject, topic, data) {
    if (topic == "sessionstore-windows-restored") {
      gSessionRestored = true;
      return;
    }
    const win = subject;
    if (win?.document?.documentElement?.getAttribute("windowtype") != "navigator:browser") {
      return;
    }
    if (topic == "zen-embed-browser-window") {
      win.document.documentElement.setAttribute("zen-embedded", "true");
      lazy.ZenEmbedDialogs.browserWindow(win);
      gPanes.push(win);
      win.addEventListener(
        "unload",
        () => gPanes.splice(gPanes.indexOf(win), 1),
        { once: true }
      );
      for (const stray of gWaitingStrays) {
        gWaitingStrays.delete(stray);
        this.takeStray(stray);
      }
      return;
    }
    if (topic == "zen-embed-stray-window") {
      this.takeStray(win);
      return;
    }
    if (topic != "zen-embed-command") {
      return;
    }
    const newline = data.indexOf("\n");
    const op = Number(newline < 0 ? data : data.slice(0, newline));
    const text = newline < 0 ? "" : data.slice(newline + 1);
    // Before its first paint the window has no tabs to act on yet.
    win.delayedStartupPromise.then(() => this.run(win, op, text)).catch(console.error);
  },

  // Moves a stray window's tabs into the pane's window and closes it, once
  // both have their tabs.
  takeStray(stray) {
    const pane = gPanes.at(-1);
    if (!pane) {
      gWaitingStrays.add(stray);
      return;
    }
    const select = gSessionRestored;
    // A window the startup's session restores has its tabs' state only once
    // that restore is over.
    Promise.all([
      stray.delayedStartupPromise,
      pane.delayedStartupPromise,
      select ? null : lazy.SessionStore.promiseAllWindowsRestored,
    ])
      .then(() => {
        if (stray.closed) {
          return;
        }
        if (pane.closed || lazy.PrivateBrowsingUtils.isWindowPrivate(stray)) {
          stray.close();
          return;
        }
        const gBrowser = pane.gBrowser;
        const strayBrowser = stray.gBrowser;
        const selected = strayBrowser.selectedTab;
        let tabIndex = gBrowser.selectedTab._tPos + 1;
        for (const tab of [...strayBrowser.tabs]) {
          // Zen's empty tab, and a synced window's copies of the pane's own
          // tabs, stay behind.
          if (
            tab.hasAttribute("zen-empty-tab") ||
            (tab.id && stray.gZenWindowSync && pane.document.getElementById(tab.id))
          ) {
            continue;
          }
          // A tab the session has not loaded yet has no page to move: its
          // state (address, title, history) is restored in a new tab.
          if (tab.hasAttribute("pending")) {
            lazy.SessionStore.duplicateTab(pane, tab, 0, false, { inBackground: true });
            continue;
          }
          const adopted = gBrowser.adoptTab(tab, {
            tabIndex: select ? tabIndex : undefined,
            selectTab: select && tab == selected,
          });
          if (adopted && select) {
            tabIndex = adopted._tPos + 1;
          }
        }
        stray.close();
      })
      .catch(console.error);
  },

  run(win, op, text) {
    if (win.closed) {
      return;
    }
    const gBrowser = win.gBrowser;
    switch (op) {
      case COMMAND_NAVIGATE: {
        let uri;
        try {
          uri = Services.io.newURI(text);
        } catch {
          return;
        }
        if (!uri.schemeIs("http") && !uri.schemeIs("https") && !uri.schemeIs("file")) {
          return;
        }
        const principal = Services.scriptSecurityManager.getSystemPrincipal();
        const selected = gBrowser.selectedTab;
        // Zen's empty tab (zen-empty-tab) stays hidden whatever it loads: a
        // new tab instead.
        if (
          win.isBlankPageURL(gBrowser.selectedBrowser.currentURI.spec) &&
          !selected.pinned &&
          !selected.hasAttribute("zen-empty-tab")
        ) {
          gBrowser.selectedBrowser.fixupAndLoadURIString(uri.spec, { triggeringPrincipal: principal });
        } else {
          gBrowser.selectedTab = gBrowser.addTab(uri.spec, { triggeringPrincipal: principal });
        }
        break;
      }
      case COMMAND_RELOAD:
        gBrowser.reload();
        break;
      case COMMAND_BACK:
        gBrowser.goBack();
        break;
      case COMMAND_FORWARD:
        gBrowser.goForward();
        break;
      case COMMAND_STOP:
        gBrowser.stop();
        break;
      case COMMAND_CLOSE:
        win.close();
        break;
    }
  },

  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
};
