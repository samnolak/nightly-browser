/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NewTabUtils: "resource://gre/modules/NewTabUtils.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const SITES_PREF = "zen.urlbar.empty-tab-sites.enabled";
const MAX_SITES = 6;
// Takes the text color, which `page-icon:`'s own fallback cannot.
const DEFAULT_ICON = "chrome://global/skin/icons/defaultFavicon.svg";

/**
 * What sits behind the floating URL bar while the empty tab is shown: a
 * backdrop in the space's colors and the most visited sites, from local
 * history only.
 *
 * The page is the new tab, and the floating URL bar is its input: whenever the
 * page shows in the active window without the bar, the bar opens over it again
 * (a new-tab session, as ⌘T opens), and a bar left open while the window was
 * inactive gets the keyboard back. Firefox's own paths leave the empty tab
 * without one: Esc or a click on the page closes the bar, the window losing
 * the focus can (Chats ↔ Browser in the embedder) and nothing reopens it when
 * the focus comes back, and closing the last tab only focuses the bar in place.
 */
export class nsZenEmptyTabPage {
  #page = null;
  #sites = null;
  // Bumped on every refresh, so a slow query cannot overwrite a newer one.
  #refreshId = 0;
  #typingObserver = null;
  #urlbarTimer = null;

  init() {
    this.#page = document.getElementById("zen-empty-tab-page");
    this.#sites = document.getElementById("zen-empty-tab-sites");
    this.#sites.addEventListener("click", this);

    // Suggestions take the place of the sites as soon as anything is typed.
    this.#typingObserver = new MutationObserver(() => this.#updateTyping());
    this.#typingObserver.observe(gURLBar, {
      attributes: true,
      attributeFilter: ["usertyping"],
    });

    // Where the empty tab is left without its bar: the window gets the focus
    // back, the focus lands on the empty tab's browser (the bar closing hands
    // it there), or the bar is focused in place (the last tab closed, a click
    // on it in the sidebar).
    window.addEventListener("activate", this);
    gBrowser.tabpanels.addEventListener("focus", this, true);
    gURLBar.inputField.addEventListener("focus", this);
    window.addEventListener(
      "unload",
      () => {
        this.#typingObserver.disconnect();
        clearTimeout(this.#urlbarTimer);
      },
      { once: true }
    );
  }

  /** Whether the page shows: the empty tab is selected, on its own. */
  get shown() {
    return !!this.#page && !this.#page.hidden;
  }

  handleEvent(event) {
    switch (event.type) {
      case "click": {
        const site = event.target.closest(".zen-empty-tab-site");
        if (site && event.button === 0) {
          gZenUIManager.openAndChangeToTab(site.dataset.url);
        }
        break;
      }
      case "activate":
        this.#scheduleUrlbar();
        break;
      case "focus":
        if (
          event.target === gURLBar.inputField ||
          event.target === gBrowser.selectedBrowser
        ) {
          this.#scheduleUrlbar();
        }
        break;
    }
  }

  /**
   * Opens the bar over the page after the current task: a bar that is closing
   * has finished by then (its session ends in timeouts of its own), and the
   * tab switch or window activation that showed the page has placed the focus.
   * A bar still open (the window active again) gets the keyboard back.
   *
   * @param {number} [retries] - Further tries while a closing session still
   *   holds the bar.
   */
  #scheduleUrlbar(retries = 3) {
    if (!this.shown || this.#urlbarTimer) {
      return;
    }
    this.#urlbarTimer = setTimeout(() => {
      this.#urlbarTimer = null;
      this.#openUrlbar(retries);
    }, 0);
  }

  #openUrlbar(retries) {
    if (!this.shown || Services.focus.activeWindow !== window) {
      return;
    }
    if (gURLBar.hasAttribute("zen-newtab")) {
      // A session whose close handler is gone is still tearing down.
      if (!gURLBar._zenHandleUrlbarClose) {
        if (retries > 0) {
          this.#scheduleUrlbar(retries - 1);
        }
        return;
      }
      if (gURLBar.focused) {
        return;
      }
    }
    // The user went somewhere else on purpose: the sidebar, a panel, a menu.
    const focused = document.activeElement;
    if (
      focused &&
      focused !== document.documentElement &&
      focused !== gBrowser.selectedBrowser &&
      focused !== gURLBar.inputField
    ) {
      return;
    }
    if (
      [...document.querySelectorAll("panel, menupopup")].some(
        popup => popup.state === "open" || popup.state === "showing"
      )
    ) {
      return;
    }
    // A new-tab session as ⌘T opens, or the open one's bar with the keyboard.
    gZenUIManager.handleNewTab(false, false, "tab");
  }

  /**
   * Shows the page when the empty tab is the selected tab on its own. Inside
   * a split view it is only one pane, which the page would otherwise cover
   * along with its neighbours.
   */
  update() {
    if (!this.#page) {
      return;
    }
    const tab = gBrowser.selectedTab;
    const active = !!tab?.hasAttribute("zen-empty-tab") && !tab.splitView;
    this.#page.hidden = !active;
    gURLBar.toggleAttribute("zen-empty-tab-page", active);
    this.#updateTyping();
    if (active) {
      this.#refreshSites();
      this.#scheduleUrlbar();
    }
  }

  #updateTyping() {
    this.#page.toggleAttribute("typing", gURLBar.hasAttribute("usertyping"));
  }

  async #refreshSites() {
    const refreshId = ++this.#refreshId;
    if (
      lazy.PrivateBrowsingUtils.isWindowPrivate(window) ||
      !Services.prefs.getBoolPref(SITES_PREF, true)
    ) {
      this.#sites.replaceChildren();
      return;
    }
    let links;
    let hasIcon;
    try {
      links = (
        await lazy.NewTabUtils.activityStreamLinks.getTopSites({
          numItems: MAX_SITES,
          includeFavicon: false,
        })
      ).slice(0, MAX_SITES);
      hasIcon = await Promise.all(
        links.map(link =>
          lazy.PlacesUtils.favicons
            .getFaviconForPage(Services.io.newURI(link.url))
            .then(
              favicon => !!favicon,
              () => false
            )
        )
      );
    } catch (e) {
      console.error("ZenEmptyTabPage: could not read top sites", e);
      return;
    }
    if (refreshId !== this.#refreshId) {
      return;
    }
    this.#sites.replaceChildren(
      ...links.map((link, i) => this.#createSite(link, hasIcon[i]))
    );
  }

  #createSite(link, hasIcon) {
    const site = document.createElement("button");
    site.className = "zen-empty-tab-site";
    site.setAttribute("role", "listitem");
    site.dataset.url = link.url;
    site.title = link.title ? `${link.title}\n${link.url}` : link.url;

    const iconBox = document.createElement("span");
    iconBox.className = "zen-empty-tab-site-icon";
    const icon = document.createElement("img");
    icon.src = hasIcon ? `page-icon:${link.url}#size=32` : DEFAULT_ICON;
    icon.alt = "";
    icon.decoding = "async";
    iconBox.append(icon);

    const label = document.createElement("span");
    label.className = "zen-empty-tab-site-label";
    label.textContent = lazy.NewTabUtils.shortURL(link) || link.url;

    site.append(iconBox, label);
    return site;
  }
}
