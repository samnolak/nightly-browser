/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ZenUIComponent } from "resource:///modules/zen/ui/ZenUIComponent.sys.mjs";
import {
  INCOMING_TOPIC,
  STATE_TOPIC,
  ZenTeamLink,
} from "resource:///modules/zen/teams/ZenTeamLink.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});

const DIALOG_URL = "chrome://browser/content/zen-team-share.xhtml";
const FTL = "browser/zen-teams.ftl";
// A screenshot travels inside the team item (SERVER_DESIGN §3.0, ≤ 64 KiB per
// operation): a JPEG of at most this many bytes.
export const MAX_SCREENSHOT_BYTES = 47 * 1024;
const MAX_GROUP_TABS = 100;
const TOAST_MS = 8000;

function shareableUrl(uri) {
  return (uri?.schemeIs("https") || uri?.schemeIs("http")) && !uri.userPass
    ? uri.spec
    : null;
}

// Query and fragment parameters that usually carry a secret (B2: the sender
// is warned and can strip them before a link leaves the browser).
const SECRET_PARAM =
  /^(access[_-]?token|id[_-]?token|refresh[_-]?token|token|auth|authorization|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|session|sessionid|session[_-]?id|sid|jsessionid|phpsessid|code|state|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|otp)$/i;

/** The names of the URL's query and fragment parameters that look like secrets. */
export function secretParams(url) {
  const found = new Set();
  const parsed = URL.parse(url);
  if (!parsed) {
    return [];
  }
  for (const [name] of parsed.searchParams) {
    if (SECRET_PARAM.test(name)) {
      found.add(name);
    }
  }
  for (const [name] of new URLSearchParams(parsed.hash.slice(1))) {
    if (SECRET_PARAM.test(name)) {
      found.add(name);
    }
  }
  return [...found];
}

/** The URL without its secret-looking query and fragment parameters. */
export function stripSecrets(url) {
  const parsed = URL.parse(url);
  if (!parsed) {
    return url;
  }
  for (const name of [...parsed.searchParams.keys()]) {
    if (SECRET_PARAM.test(name)) {
      parsed.searchParams.delete(name);
    }
  }
  const hash = new URLSearchParams(parsed.hash.slice(1));
  if ([...hash.keys()].some(name => SECRET_PARAM.test(name))) {
    for (const name of [...hash.keys()]) {
      if (SECRET_PARAM.test(name)) {
        hash.delete(name);
      }
    }
    parsed.hash = hash.toString();
  }
  return parsed.href;
}

/** The page of a tab as a link item, or null when it cannot be shared. */
export function linkOf(tab) {
  // A closed tab (a stale context menu target) has no browser any more.
  const url = shareableUrl(tab?.linkedBrowser?.currentURI);
  return url ? { kind: "link", url, title: tab.label || url } : null;
}

/** A tab group as a collection item (its shareable tabs), or null. */
export function collectionOf(group) {
  const links = group.tabs
    .map(linkOf)
    .filter(Boolean)
    .slice(0, MAX_GROUP_TABS)
    .map(({ url, title }) => ({ url, title }));
  return links.length
    ? { kind: "collection", title: group.label || links[0].title, links }
    : null;
}

/**
 * Re-encodes an image as a JPEG small enough to travel inside a team item:
 * at most 1600 px wide, lowering the quality and then the size until it fits.
 *
 * @returns {Promise<string>} The JPEG, base64.
 */
export async function screenshotJpeg(window, bytes) {
  const bitmap = await window.createImageBitmap(
    new window.Blob([bytes], { type: "image/png" })
  );
  let scale = Math.min(1, 1600 / bitmap.width);
  const canvas = window.document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas"
  );
  for (;;) {
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.6, 0.45, 0.3]) {
      const blob = await new Promise(resolve =>
        canvas.toBlob(resolve, "image/jpeg", quality)
      );
      if (blob.size <= MAX_SCREENSHOT_BYTES) {
        const data = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let i = 0; i < data.length; i += 0x8000) {
          binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
        }
        return window.btoa(binary);
      }
    }
    scale *= 0.7;
  }
}

/**
 * Team sharing in a browser window: "Share … with Team" in the page and tab
 * context menus (a page, or the tab group the tab is in — B1 auto groups
 * included), the share dialog for gallery screenshots, and toasts for what
 * team members shared with this member (Open accepts it in Ombra and opens it).
 * Everything goes through Ombra (ZenTeamLink); while Ombra cannot share, the
 * menu items are disabled and the menu says why.
 */
export class ZenTeamsUI extends ZenUIComponent {
  /** @type {WeakMap<Window, ZenTeamsUI>} */
  static #windows = new WeakMap();

  /** The component of a browser window (the gallery shares through it). */
  static forWindow(window) {
    return ZenTeamsUI.#windows.get(window) ?? null;
  }

  #items = [];
  #observers = [];

  init() {
    ZenTeamsUI.#windows.set(this.window, this);
    const { document } = this;
    this.window.MozXULElement.insertFTLIfNeeded(FTL);
    const tabMenu = document.getElementById("tabContextMenu");
    const anchor = document.getElementById("context_sendTabToDevice");
    this.#addItems(tabMenu, anchor?.nextElementSibling ?? null, [
      ["zen-team-share-tab", () => this.#shareTab()],
      ["zen-team-share-group", () => this.#shareGroup()],
    ]);
    const pageMenu = document.getElementById("contentAreaContextMenu");
    this.#addItems(
      pageMenu,
      document.getElementById("context-sendpagetodevice")?.nextElementSibling ??
        null,
      [["zen-team-share-page", () => this.#sharePage()]]
    );
    this.#observe(INCOMING_TOPIC, data => this.#incoming(JSON.parse(data)));
    this.#observe(STATE_TOPIC, () => this.#refreshItems());
    ZenTeamLink.startInbox();
  }

  uninit() {
    for (const [topic, observer] of this.#observers) {
      Services.obs.removeObserver(observer, topic);
    }
  }

  #observe(topic, callback) {
    const observer = (_subject, _topic, data) => callback(data);
    Services.obs.addObserver(observer, topic);
    this.#observers.push([topic, observer]);
  }

  #addItems(menu, before, entries) {
    if (!menu) {
      return;
    }
    const { document } = this;
    for (const [id, command] of entries) {
      const item = document.createXULElement("menuitem");
      item.id = `context-${id}`;
      document.l10n.setAttributes(item, id);
      item.addEventListener("command", command);
      menu.insertBefore(item, before);
      this.#items.push(item);
    }
    // Why sharing is not possible now, under the disabled items.
    const reason = document.createXULElement("menuitem");
    reason.id = `${menu.id}-zen-team-reason`;
    reason.classList.add("zen-team-share-reason");
    reason.disabled = true;
    reason.hidden = true;
    menu.insertBefore(reason, before);
    this.#items.push(reason);
    menu.addEventListener("popupshowing", event => {
      if (event.target === menu) {
        this.#refreshItems();
        ZenTeamLink.state().then(() => this.#refreshItems());
      }
    });
  }

  #refreshItems() {
    const state = ZenTeamLink.cachedState;
    const contextTab = this.window.TabContextMenu?.contextTab;
    for (const item of this.#items) {
      if (item.classList.contains("zen-team-share-reason")) {
        item.hidden = !state || state.ready;
        if (state && !state.ready) {
          this.document.l10n.setAttributes(item, "zen-team-unavailable", {
            reason: state.reason,
          });
        }
        continue;
      }
      let available = true;
      if (item.id === "context-zen-team-share-group") {
        item.hidden = !contextTab?.group;
        available = !!contextTab?.group && !!collectionOf(contextTab.group);
      } else if (item.id === "context-zen-team-share-tab") {
        available = !!contextTab && !!linkOf(contextTab);
      } else {
        available = !!linkOf(this.window.gBrowser.selectedTab);
      }
      item.disabled = !state?.ready || !available;
    }
  }

  #sharePage() {
    const item = linkOf(this.window.gBrowser.selectedTab);
    if (item) {
      this.openShareDialog(item);
    }
  }

  #shareTab() {
    const item = linkOf(this.window.TabContextMenu.contextTab);
    if (item) {
      this.openShareDialog(item);
    }
  }

  #shareGroup() {
    const group = this.window.TabContextMenu.contextTab?.group;
    const item = group && collectionOf(group);
    if (item) {
      this.openShareDialog(item);
    }
  }

  /**
   * Asks for a comment and the recipients, then shares through Ombra.
   *
   * @param {object} item - See ZenTeamLink.share.
   * @returns {Promise<number>} How many members it was sent to (0: not sent).
   */
  async openShareDialog(item) {
    const state = await ZenTeamLink.state({ fresh: true });
    if (!state.ready) {
      this.#refreshItems();
      this.window.gZenUIManager.showToast("zen-team-unavailable-toast", {
        l10nArgs: { reason: state.reason },
        timeout: TOAST_MS,
      });
      return 0;
    }
    const args = { item, state, sent: 0 };
    await this.window.gDialogBox.open(DIALOG_URL, args);
    if (args.sent) {
      this.window.gZenUIManager.showToast("zen-team-shared", {
        l10nArgs: { count: args.sent },
      });
    }
    return args.sent;
  }

  /** Gallery: shares a screenshot (PNG bytes) with its source page. */
  async shareScreenshot(shot, bytes) {
    const url = shareableUrl(
      this.window.URL.canParse(shot.url) ? Services.io.newURI(shot.url) : null
    );
    return this.openShareDialog({
      kind: "screenshot",
      title: shot.title || url || "",
      url: url ?? undefined,
      jpeg: await screenshotJpeg(this.window, bytes),
    });
  }

  #incoming(item) {
    if (lazy.BrowserWindowTracker.getTopWindow() !== this.window) {
      return;
    }
    const { document } = this;
    const id = `zen-team-incoming-${item.kind}`;
    this.window.gZenUIManager.showToast(id, {
      l10nArgs: { author: item.authorName, title: item.title },
      timeout: TOAST_MS,
      button: {
        id: `zen-team-toast-open-${item.kind}`,
        command: () => this.openIncoming(item),
      },
    });
    const button = document.getElementById(`zen-team-toast-open-${item.kind}`);
    if (button) {
      button.classList.add("zen-toast-labelled");
      document.l10n.setAttributes(button, "zen-team-toast-open");
    }
  }

  /** Accepts a shared item in Ombra and opens it: a tab, a tab group, or the screenshot. */
  async openIncoming(item) {
    const answer = await ZenTeamLink.open(item);
    if (!answer.ok) {
      this.window.gZenUIManager.showToast("zen-team-open-failed", {
        timeout: TOAST_MS,
      });
      return;
    }
    const { gBrowser } = this.window;
    const triggeringPrincipal =
      Services.scriptSecurityManager.createNullPrincipal({});
    if (answer.kind === "link") {
      gBrowser.selectedTab = gBrowser.addTab(answer.url, {
        triggeringPrincipal,
      });
    } else if (answer.kind === "collection") {
      const tabs = (answer.links || []).map(link =>
        gBrowser.addTab(link.url, { triggeringPrincipal })
      );
      if (tabs.length) {
        gBrowser.addTabGroup(tabs, { label: answer.title, insertBefore: tabs[0] });
        gBrowser.selectedTab = tabs[0];
      }
    } else if (answer.kind === "screenshot" && answer.data) {
      const dir = PathUtils.join(PathUtils.tempDir, "nightly-team-shared");
      await IOUtils.makeDirectory(dir, { permissions: 0o700 });
      const file = PathUtils.join(dir, `${answer.id}.jpg`);
      await IOUtils.write(
        file,
        Uint8Array.from(this.window.atob(answer.data), c => c.charCodeAt(0))
      );
      gBrowser.selectedTab = gBrowser.addTab(PathUtils.toFileURI(file), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
    }
  }
}
