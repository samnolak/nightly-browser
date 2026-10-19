// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { ZenUIComponent } from "resource:///modules/zen/ui/ZenUIComponent.sys.mjs";

const lazy = {};

XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "externalProtocolService",
  "@mozilla.org/uriloader/external-protocol-service;1",
  Ci.nsIExternalProtocolService
);

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "enabled",
  "zen.open-in-app.enabled",
  true
);

// Figma file types the desktop app opens itself. Every other path (marketing,
// help, auth, ...) is sent back to the browser by the app, so it must stay here.
const FIGMA_FILE_TYPES = new Set([
  "board",
  "buzz",
  "deck",
  "design",
  "file",
  "make",
  "proto",
  "rev",
  "site",
  "slides",
  "spec",
  "weave",
]);

/**
 * Websites that have a desktop app registered for a custom URL scheme. When
 * one of these apps is installed, top-level navigations to the site are handed
 * to the app instead of loading in the browser.
 *
 * toAppURL returns the app URL for a site URL, or null when the app can't
 * open that page.
 */
const APP_HANDOFFS = [
  {
    scheme: "figma",
    appName: "Figma",
    hosts: ["www.figma.com", "figma.com"],
    /** @param {URL} url */
    toAppURL(url) {
      // The app opens these in the browser again (see its navigation config).
      if (url.searchParams.has("openInBrowser")) {
        return null;
      }
      const [type, key, sub] = url.pathname.split("/").slice(1);
      const isFileBrowser = type === "files";
      const isFile =
        FIGMA_FILE_TYPES.has(type) &&
        !!key &&
        sub !== "image" &&
        !(type === "file" && key === "employee");
      if (!isFileBrowser && !isFile) {
        return null;
      }
      // The app maps figma://<path> back onto https://www.figma.com/<path>.
      return `figma://${url.pathname.slice(1)}${url.search}${url.hash}`;
    },
  },
];

/**
 * Per-window listener that opens links in their desktop app.
 *
 * Direct navigations are caught when the load starts, before anything is
 * fetched. Links that only reach the site through redirects (link wrappers,
 * figma.com -> www.figma.com, ...) are caught when the redirected document
 * commits.
 */
export class ZenOpenInApp extends ZenUIComponent {
  /**
   * Per-browser state of the top-level load in progress.
   *
   * @type {WeakMap<MozBrowser, {fresh: boolean, restoring: boolean}>}
   */
  #loads = new WeakMap();

  /** URLs the user chose to keep in the browser; consumed on the next load. */
  #openHere = new Set();

  init() {
    this.listenBrowserTabsProgress();
  }

  /**
   * @param {MozBrowser} aBrowser
   * @param {nsIWebProgress} aWebProgress
   * @param {nsIRequest} aRequest
   * @param {number} aStateFlags
   */
  onStateChange(aBrowser, aWebProgress, aRequest, aStateFlags) {
    const wpl = Ci.nsIWebProgressListener;
    if (
      !aWebProgress?.isTopLevel ||
      !(aStateFlags & wpl.STATE_START) ||
      !(aStateFlags & wpl.STATE_IS_DOCUMENT)
    ) {
      return;
    }

    const load = {
      // A new tab still on its initial about:blank: nothing to go back to.
      fresh:
        aBrowser.browsingContext?.currentWindowGlobal?.isInitialDocument ??
        false,
      restoring: !!(aStateFlags & wpl.STATE_RESTORING),
    };
    this.#loads.set(aBrowser, load);
    if (load.restoring) {
      return;
    }

    let uri;
    try {
      uri = aRequest.QueryInterface(Ci.nsIChannel).URI;
    } catch (e) {
      return;
    }
    // A reload of the page the tab already shows.
    if (aBrowser.currentURI?.equals(uri)) {
      return;
    }
    const target = this.#findHandoff(aBrowser, uri);
    if (!target || !this.#launch(target)) {
      return;
    }

    // Under Fission aRequest is a parent-side stand-in whose cancel() throws;
    // stopping the browser proxies the cancel to the content process.
    aBrowser.stop();
    this.#loads.delete(aBrowser);
    this.#finish(aBrowser, uri.spec, target.app, load.fresh);
  }

  /**
   * @param {MozBrowser} aBrowser
   * @param {nsIWebProgress} aWebProgress
   * @param {nsIRequest} aRequest
   * @param {nsIURI} aLocation
   * @param {number} aFlags
   */
  onLocationChange(aBrowser, aWebProgress, aRequest, aLocation, aFlags) {
    if (!aWebProgress?.isTopLevel) {
      return;
    }
    const load = this.#loads.get(aBrowser);
    this.#loads.delete(aBrowser);
    if (
      !load ||
      load.restoring ||
      aFlags &
        (Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT |
          Ci.nsIWebProgressListener.LOCATION_CHANGE_RELOAD |
          Ci.nsIWebProgressListener.LOCATION_CHANGE_ERROR_PAGE)
    ) {
      return;
    }
    const target = this.#findHandoff(aBrowser, aLocation);
    if (!target || !this.#launch(target)) {
      return;
    }

    // The site's document already replaced the previous page: return to it,
    // or drop the tab if the link opened it.
    aBrowser.stop();
    const closeTab = load.fresh || !aBrowser.canGoBack;
    if (!closeTab) {
      aBrowser.goBack();
    }
    this.#finish(aBrowser, aLocation.spec, target.app, closeTab);
  }

  /**
   * @param {MozBrowser} aBrowser
   * @param {nsIURI} aURI
   * @returns {{app: object, appURL: string} | null}
   */
  #findHandoff(aBrowser, aURI) {
    if (!lazy.enabled || !aURI.schemeIs("https")) {
      return null;
    }
    if (this.#openHere.delete(aURI.spec)) {
      return null;
    }
    const app = APP_HANDOFFS.find(a => a.hosts.includes(aURI.host));
    if (!app) {
      return null;
    }
    const tab = this.window.gBrowser.getTabForBrowser(aBrowser);
    // Pinned tabs and Glance previews are deliberate in-browser views.
    if (!tab || tab.pinned || tab.hasAttribute("zen-glance-tab")) {
      return null;
    }
    const appURL = app.toAppURL(new URL(aURI.spec));
    if (
      !appURL ||
      !lazy.externalProtocolService.externalProtocolHandlerExists(app.scheme)
    ) {
      return null;
    }
    return { app, appURL };
  }

  /**
   * Launches the app's OS handler directly. The external protocol path would
   * ask "Allow this site to open the link?" for a navigation the browser itself
   * decided to make. A handler the user picked in Settings > Applications is
   * honoured; otherwise the OS default app is used. The handler info is not
   * stored, so the user's settings are left untouched.
   *
   * @param {{app: object, appURL: string}} aTarget
   * @returns {boolean} Whether the app was launched.
   */
  #launch({ app, appURL }) {
    const handlerInfo = lazy.externalProtocolService.getProtocolHandlerInfo(
      app.scheme
    );
    if (handlerInfo.preferredAction !== Ci.nsIHandlerInfo.useHelperApp) {
      handlerInfo.preferredAction = Ci.nsIHandlerInfo.useSystemDefault;
    }
    try {
      handlerInfo.launchWithURI(Services.io.newURI(appURL));
    } catch (e) {
      console.error(`ZenOpenInApp: could not open ${app.appName}:`, e);
      return false;
    }
    return true;
  }

  /**
   * @param {MozBrowser} aBrowser - The browser the site was loading in.
   * @param {string} aSiteURL - The site URL, kept to reopen it in the browser.
   * @param {object} aApp - The APP_HANDOFFS entry that was launched.
   * @param {boolean} aCloseTab - Whether the tab only existed for this link.
   */
  #finish(aBrowser, aSiteURL, aApp, aCloseTab) {
    const win = this.window;
    const gBrowser = win.gBrowser;
    const tab = gBrowser.getTabForBrowser(aBrowser);

    // Defer so we don't mutate the tab strip from inside a progress notification.
    win.setTimeout(() => {
      if (aCloseTab && tab?.isConnected) {
        gBrowser.removeTab(tab, { closeWindowWithLastTab: false });
      }
      win.gZenUIManager.showToast("zen-open-in-app-toast", {
        l10nArgs: { app: aApp.appName },
        timeout: 4000,
        button: {
          id: "zen-open-in-app-open-here-button",
          command: () => {
            this.#openHere.add(aSiteURL);
            gBrowser.addTab(aSiteURL, {
              triggeringPrincipal:
                Services.scriptSecurityManager.getSystemPrincipal(),
              inBackground: false,
            });
          },
        },
      });
    }, 0);
  }
}
