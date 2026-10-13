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
 */
export class nsZenEmptyTabPage {
  #page = null;
  #sites = null;
  // Bumped on every refresh, so a slow query cannot overwrite a newer one.
  #refreshId = 0;
  #typingObserver = null;

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
    window.addEventListener("unload", () => this.#typingObserver.disconnect(), {
      once: true,
    });
  }

  handleEvent(event) {
    const site = event.target.closest(".zen-empty-tab-site");
    if (event.type === "click" && site && event.button === 0) {
      gZenUIManager.openAndChangeToTab(site.dataset.url);
    }
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
