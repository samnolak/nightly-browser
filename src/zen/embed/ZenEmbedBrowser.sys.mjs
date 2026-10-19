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
// fits it into the embedder's sheet. Only in an embedder's runtime
// (NIGHTLY_EMBED_SERVICE).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ZenEmbedDialogs: "resource:///actors/ZenEmbedDialogs.sys.mjs",
});

const COMMAND_NAVIGATE = 1;
const COMMAND_RELOAD = 2;
const COMMAND_BACK = 3;
const COMMAND_FORWARD = 4;
const COMMAND_STOP = 5;
const COMMAND_CLOSE = 6;

let gStarted = false;

export const ZenEmbedBrowser = {
  // browser-before-ui-startup (ZenComponents.manifest): once per process.
  init() {
    if (gStarted || !Services.env.get("NIGHTLY_EMBED_SERVICE")) {
      return;
    }
    gStarted = true;
    Services.obs.addObserver(this, "zen-embed-command");
    Services.obs.addObserver(this, "zen-embed-browser-window");
  },

  observe(subject, topic, data) {
    const win = subject;
    if (win?.document?.documentElement?.getAttribute("windowtype") != "navigator:browser") {
      return;
    }
    if (topic == "zen-embed-browser-window") {
      win.document.documentElement.setAttribute("zen-embedded", "true");
      lazy.ZenEmbedDialogs.browserWindow(win);
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
