// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { ZenUIComponent } from "resource:///modules/zen/ui/ZenUIComponent.sys.mjs";
import {
  MODE_ALWAYS,
  MODE_NEVER,
  MODES,
  OPEN_IN_APP_APPS,
  decideNavigation,
  findAppForSite,
  findAppLink,
} from "resource:///modules/zen/openinapp/ZenOpenInAppRules.sys.mjs";

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

const APP_PREF_BRANCH = "zen.open-in-app.app.";

/**
 * Browser windows' documents -> their component. Keyed by document: the
 * window a category entry gets and a browser's ownerGlobal are not the same
 * object here.
 *
 * @type {WeakMap<Document, ZenOpenInApp>}
 */
const gWindows = new WeakMap();
/** @type {WeakMap<MozBrowser, Set<string>>} pages kept in the browser per tab */
const gKept = new WeakMap();
/** URLs to open in the browser on their next load (Open Link in Browser). */
const gOpenHere = new Set();
let gStarted = false;

function parseURL(aSpec) {
  try {
    return new URL(aSpec);
  } catch {
    return null;
  }
}

/**
 * Opens links to sites with an installed desktop app in that app, as Arc and
 * Chrome do: a tab's top-level navigation (a click, a typed URL, a link from
 * another app or from the embedder) to a page the app opens is stopped before
 * any request goes out, the app gets its own URL through LaunchServices, and
 * the tab goes back to what it showed (a tab opened only for the link
 * closes). Rules: ZenOpenInAppRules.sys.mjs; settings: prefs/zen/open-in-app.yaml.
 *
 * Every document load of the parent process passes http-on-modify-request,
 * including redirects (figma.com -> www.figma.com, link wrappers) and loads a
 * service worker answers; subresources, frames, prefetches and anything
 * outside a browser window's tabs are left alone.
 */
export const ZenOpenInAppService = {
  /** The known apps; tests add their own. */
  apps: OPEN_IN_APP_APPS,

  start() {
    if (gStarted) {
      return;
    }
    gStarted = true;
    Services.obs.addObserver(this, "http-on-modify-request");
  },

  /**
   * @param {object} aApp
   * @returns {string} One of MODES.
   */
  modeFor(aApp) {
    const mode = Services.prefs.getStringPref(
      APP_PREF_BRANCH + aApp.id,
      MODE_ALWAYS
    );
    return MODES.includes(mode) ? mode : MODE_ALWAYS;
  },

  setMode(aApp, aMode) {
    Services.prefs.setStringPref(APP_PREF_BRANCH + aApp.id, aMode);
  },

  /** Whether the OS has an app for the app's URL scheme (LaunchServices). */
  isInstalled(aApp) {
    return lazy.externalProtocolService.externalProtocolHandlerExists(
      aApp.scheme
    );
  },

  /** The name of the app the OS opens the scheme with ("Толк", "Figma"). */
  appName(aApp) {
    try {
      const name = lazy.externalProtocolService.getApplicationDescription(
        aApp.scheme
      );
      if (name) {
        return name.replace(/\.app$/, "");
      }
    } catch {}
    return aApp.name;
  },

  /**
   * Opens an app URL with the scheme's OS handler. The external protocol path
   * would ask "Allow this site to open the link?" for a navigation the browser
   * itself decided to hand off. A handler the user picked in Settings >
   * Applications is honoured; otherwise the OS default app is used. The
   * handler info is not stored, so the user's settings are left untouched.
   *
   * @param {string} aAppURL
   * @returns {boolean} Whether the app was launched.
   */
  launch(aAppURL) {
    try {
      const uri = Services.io.newURI(aAppURL);
      const handlerInfo = lazy.externalProtocolService.getProtocolHandlerInfo(
        uri.scheme
      );
      if (handlerInfo.preferredAction !== Ci.nsIHandlerInfo.useHelperApp) {
        handlerInfo.preferredAction = Ci.nsIHandlerInfo.useSystemDefault;
      }
      handlerInfo.launchWithURI(uri);
    } catch (e) {
      console.error(`ZenOpenInApp: could not open ${aAppURL}:`, e);
      return false;
    }
    return true;
  },

  /** The next load of aSpec stays in the browser. */
  openHere(aSpec) {
    gOpenHere.add(aSpec);
  },

  /** Loads of aSpec in this tab stay in the browser (back, reload, ...). */
  keep(aBrowser, aSpec) {
    let kept = gKept.get(aBrowser);
    if (!kept) {
      kept = new Set();
      gKept.set(aBrowser, kept);
    }
    kept.add(aSpec);
  },

  /**
   * What would happen to a link opened from a page: the app link, when the
   * app is installed and not set to stay in the browser.
   *
   * @param {string} aSpec
   * @returns {{app: object, appURL: string} | null}
   */
  linkFor(aSpec) {
    const url = parseURL(aSpec);
    const link = url && findAppLink(url, this.apps);
    if (
      !lazy.enabled ||
      !link ||
      this.modeFor(link.app) === MODE_NEVER ||
      !this.isInstalled(link.app)
    ) {
      return null;
    }
    return link;
  },

  observe(aSubject, aTopic) {
    if (aTopic !== "http-on-modify-request" || !lazy.enabled) {
      return;
    }
    let channel;
    try {
      channel = aSubject.QueryInterface(Ci.nsIHttpChannel);
    } catch {
      return;
    }
    const loadInfo = channel.loadInfo;
    if (
      loadInfo.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT
    ) {
      return;
    }
    const url = parseURL(channel.URI.spec);
    const link = url && findAppLink(url, this.apps);
    if (!link) {
      return;
    }
    const nav = this.navigationFacts(loadInfo, url, link);
    const decision = decideNavigation(nav);
    if (decision.action === "browser") {
      if (nav.browser && (nav.keptHere || nav.optionHeld)) {
        // Its redirects, reloads and back/forward stay here too.
        this.keep(nav.browser, url.href);
      }
      return;
    }
    channel.cancel(Cr.NS_BINDING_ABORTED);
    nav.component.handOff({
      browser: nav.browser,
      spec: url.href,
      link,
      fresh: nav.fresh,
      ask: decision.action === "ask",
    });
  },

  /**
   * The facts decideNavigation weighs, read off a document load.
   *
   * @param {nsILoadInfo} aLoadInfo
   * @param {URL} aURL
   * @param {{app: object, appURL: string}} aLink
   */
  navigationFacts(aLoadInfo, aURL, aLink) {
    const context = aLoadInfo.browsingContext;
    const browser = context?.top.embedderElement ?? null;
    const component = browser ? gWindows.get(browser.ownerDocument) : null;
    const win = component?.window;
    const tab = component ? win.gBrowser.getTabForBrowser(browser) : null;
    const fresh =
      !!browser &&
      (browser.browsingContext?.currentWindowGlobal?.isInitialDocument ??
        true);
    const kept = browser ? gKept.get(browser) : null;
    const redirectedFrom = aLoadInfo.redirectChain.map(
      entry => entry.principal?.spec
    );
    const keptHere =
      gOpenHere.delete(aURL.href) ||
      !!kept?.has(aURL.href) ||
      redirectedFrom.some(spec => spec && kept?.has(spec));
    const current = browser && !fresh ? parseURL(browser.currentURI.spec) : null;
    return {
      enabled: lazy.enabled,
      link: aLink,
      topLevel: !!context && !context.parent,
      inTab: !!tab && !tab.hasAttribute("zen-glance-tab"),
      pinned: !!tab?.pinned,
      historyLoad:
        (context?.top.sessionHistory?.requestedIndex ?? -1) >= 0 ||
        (!!current && current.href === aURL.href),
      keptHere,
      optionHeld: !!component?.optionHeld,
      fromSameApp:
        !!current && findAppForSite(current, this.apps) === aLink.app,
      userInitiated:
        aLoadInfo.triggeringPrincipal?.isSystemPrincipal ||
        aLoadInfo.hasValidUserGestureActivation ||
        fresh,
      mode: this.modeFor(aLink.app),
      isInstalled: () => this.isInstalled(aLink.app),
      browser,
      component,
      fresh,
    };
  },

  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
};

/**
 * Per-window part: the ⌥ Option state, the "Open Link in Browser" menu item,
 * the ask prompt and what the tab does after a hand-off.
 */
export class ZenOpenInApp extends ZenUIComponent {
  #optionHeld = false;
  #menuItem = null;

  init() {
    ZenOpenInAppService.start();
    gWindows.set(this.document, this);
    // Keyboard and mouse events reach the chrome before the page, so the
    // modifiers of the click or Enter that starts a load are known here.
    for (const type of ["keydown", "keyup", "mousedown", "mouseup"]) {
      this.addEventListener(type, { capture: true });
    }
    this.addEventListener("blur");
    this.#addMenuItem();
  }

  uninit() {
    gWindows.delete(this.document);
  }

  /** ⌥ Option is held: links open in the browser. */
  get optionHeld() {
    return this.#optionHeld;
  }

  on_keydown(event) {
    this.#optionHeld = event.altKey;
  }

  on_keyup(event) {
    this.#optionHeld = event.altKey;
  }

  on_mousedown(event) {
    this.#optionHeld = event.altKey;
  }

  on_mouseup(event) {
    this.#optionHeld = event.altKey;
  }

  on_blur(event) {
    if (event.target === this.window) {
      this.#optionHeld = false;
    }
  }

  #addMenuItem() {
    const doc = this.document;
    const openInTab = doc.getElementById("context-openlinkintab");
    const menu = doc.getElementById("contentAreaContextMenu");
    if (!openInTab || !menu) {
      return;
    }
    const item = doc.createXULElement("menuitem");
    item.id = "context-openlink-inbrowser";
    item.className = "context-menu-open-link";
    item.hidden = true;
    doc.l10n.setAttributes(item, "zen-open-in-app-context-open-in-browser");
    item.addEventListener("command", () => {
      const contextMenu = this.window.gContextMenu;
      if (!contextMenu) {
        return;
      }
      ZenOpenInAppService.openHere(contextMenu.linkURL);
      // As "Open Link in New Tab" (its container and history options).
      contextMenu.openLinkInTab({ target: openInTab });
    });
    openInTab.after(item);
    this.#menuItem = item;
    menu.addEventListener("popupshowing", event => {
      if (event.target !== menu) {
        return;
      }
      const contextMenu = this.window.gContextMenu;
      const link =
        contextMenu?.onLink && !contextMenu.onMailtoLink
          ? ZenOpenInAppService.linkFor(contextMenu.linkURL)
          : null;
      item.hidden = !link;
    });
  }

  /**
   * Called once the load is cancelled: open the app (asking first when set
   * to), or load the page here after all.
   *
   * @param {object} aHandOff
   * @param {MozBrowser} aHandOff.browser
   * @param {string} aHandOff.spec - The site URL.
   * @param {{app: object, appURL: string}} aHandOff.link
   * @param {boolean} aHandOff.fresh - The tab was opened for this link.
   * @param {boolean} aHandOff.ask
   */
  async handOff({ browser, spec, link, fresh, ask }) {
    const name = ZenOpenInAppService.appName(link.app);
    if (ask) {
      let choice;
      try {
        choice = await this.#ask(browser, name);
      } catch (e) {
        console.error("ZenOpenInApp: could not ask:", e);
        choice = { app: false, remember: false };
      }
      if (choice.remember) {
        ZenOpenInAppService.setMode(
          link.app,
          choice.app ? MODE_ALWAYS : MODE_NEVER
        );
      }
      if (!choice.app) {
        this.#loadHere(browser, spec);
        return;
      }
    }
    if (!ZenOpenInAppService.launch(link.appURL)) {
      this.#loadHere(browser, spec);
      return;
    }
    this.#afterHandOff(browser, spec, name, fresh);
  }

  /**
   * @param {MozBrowser} aBrowser
   * @param {string} aName
   * @returns {Promise<{app: boolean, remember: boolean}>}
   */
  async #ask(aBrowser, aName) {
    const [title, text, openApp, openHere, remember] =
      await this.document.l10n.formatValues([
        { id: "zen-open-in-app-ask-title", args: { app: aName } },
        { id: "zen-open-in-app-ask-text", args: { app: aName } },
        { id: "zen-open-in-app-ask-open-app", args: { app: aName } },
        { id: "zen-open-in-app-ask-open-here" },
        { id: "zen-open-in-app-ask-remember", args: { app: aName } },
      ]);
    const prompt = Services.prompt;
    const flags =
      prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING +
      prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_IS_STRING +
      prompt.BUTTON_POS_0_DEFAULT;
    const result = await prompt.asyncConfirmEx(
      aBrowser.browsingContext,
      prompt.MODAL_TYPE_TAB,
      title,
      text,
      flags,
      openApp,
      openHere,
      null,
      remember,
      false
    );
    return {
      app: result.get("buttonNumClicked") === 0,
      remember: !!result.get("checked"),
    };
  }

  /** Loads the site in its tab after all (or a new one if that is gone). */
  #loadHere(aBrowser, aSpec) {
    const gBrowser = this.window.gBrowser;
    const tab = gBrowser.getTabForBrowser(aBrowser);
    const options = {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    };
    if (tab?.isConnected && !tab.closing) {
      ZenOpenInAppService.keep(aBrowser, aSpec);
      aBrowser.loadURI(Services.io.newURI(aSpec), options);
      gBrowser.selectedTab = tab;
      return;
    }
    ZenOpenInAppService.openHere(aSpec);
    gBrowser.selectedTab = gBrowser.addTab(aSpec, {
      ...options,
      inBackground: false,
    });
  }

  /**
   * The app has the link: a tab opened for it closes, any other tab stays on
   * its page with its address bar reverted. The toast offers the page here.
   */
  #afterHandOff(aBrowser, aSpec, aName, aFresh) {
    const win = this.window;
    const gBrowser = win.gBrowser;
    // Not from inside the network observer or a progress notification.
    win.setTimeout(() => {
      const tab = gBrowser.getTabForBrowser(aBrowser);
      if (tab?.isConnected && !tab.closing) {
        if (aFresh) {
          gBrowser.removeTab(tab, { closeWindowWithLastTab: false });
        } else {
          aBrowser.userTypedValue = null;
          if (tab.selected) {
            win.gURLBar.handleRevert();
          }
        }
      }
      win.gZenUIManager.showToast("zen-open-in-app-toast", {
        l10nArgs: { app: aName },
        descriptionId: "zen-open-in-app-toast-description",
        timeout: 5000,
        button: {
          id: "zen-open-in-app-open-here-button",
          command: () => this.#loadHere(aBrowser, aSpec),
        },
      });
    }, 0);
  }
}
