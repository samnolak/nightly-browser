/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { nsZenPreloadedFeature } from "chrome://browser/content/zen-components/ZenCommonUtils.mjs";
import {
  autoGroupKey,
  parseAutoGroupRules,
} from "chrome://browser/content/zen-components/ZenAutoGroupRules.mjs";

const PREF = "zen.tabs.auto-groups.";
const STATE = "zen-auto-group";
const EXCLUDED = "zen-auto-group-excluded";
const EVENTS = [
  "TabOpen",
  "TabClose",
  "TabMove",
  "TabPinned",
  "TabUnpinned",
  "TabGrouped",
  "TabUngrouped",
  "TabGroupUpdate",
  "TabGroupUngroup",
  "TabGroupRemoved",
  "TabAttrModified",
  "SSTabRestored",
  "SSWindowStateBusy",
  "SSWindowStateReady",
  "ZenWorkspaceDataChanged",
];

class ZenAutoGroups extends nsZenPreloadedFeature {
  _groups = new Map();
  _changing = false;
  _restoring = true;
  _timer = null;
  _ready = false;

  async init() {
    await Promise.all([
      SessionStore.promiseInitialized,
      gZenWorkspaces.promiseInitialized,
    ]);
    if (!gBrowserInit.delayedStartupFinished) {
      await new Promise(resolve => {
        const observer = subject => {
          if (subject === window) {
            Services.obs.removeObserver(
              observer,
              "browser-delayed-startup-finished"
            );
            resolve();
          }
        };
        Services.obs.addObserver(observer, "browser-delayed-startup-finished");
      });
    }
    if (window.closed) {
      return;
    }
    for (const type of EVENTS) {
      window.addEventListener(type, this);
    }
    Services.prefs.addObserver(PREF, this);
    this._progress = {
      onLocationChange: (browser, webProgress) => {
        if (webProgress.isTopLevel) {
          this.schedule();
        }
      },
    };
    gBrowser.addTabsProgressListener(this._progress);
    this._observer = new MutationObserver(() => this.schedule());
    this._observer.observe(gBrowser.tabContainer, {
      subtree: true,
      attributes: true,
      attributeFilter: ["zen-workspace-id", "zen-essential", "pinned"],
    });
    window.addEventListener("unload", () => this.uninit(), { once: true });
    this._restoring = false;
    this._ready = true;
    this.schedule();
  }

  uninit() {
    this._ready = false;
    clearTimeout(this._timer);
    this._observer?.disconnect();
    gBrowser.removeTabsProgressListener(this._progress);
    Services.prefs.removeObserver(PREF, this);
    for (const type of EVENTS) {
      window.removeEventListener(type, this);
    }
    this._groups.clear();
  }

  observe() {
    this.schedule();
  }

  schedule() {
    if (
      !this._ready ||
      this._changing ||
      this._restoring ||
      this._timer !== null
    ) {
      return;
    }
    // Coalesce a burst of navigation/tab events, without delaying forever during load.
    this._timer = setTimeout(() => {
      this._timer = null;
      this.reconcile();
    }, 150);
  }

  handleEvent(event) {
    if (event.type === "SSWindowStateBusy") {
      this._restoring = true;
      return;
    }
    if (event.type === "SSWindowStateReady") {
      this._restoring = false;
      this._groups.clear();
    }
    if (this._changing || this._restoring || window._zenClosingWindow) {
      return;
    }
    const group = event.target;
    const record = this._groups.get(group);
    if (
      record &&
      event.type === "TabGroupUpdate" &&
      (group.label !== record.name || group.color !== record.color)
    ) {
      this.makeManual(group);
    } else if (record && event.type === "TabGroupUngroup") {
      for (const tab of group.tabs) {
        this.exclude(tab);
      }
      this.makeManual(group);
    } else if (record && event.type === "TabGrouped") {
      let membership;
      try {
        membership = JSON.parse(
          SessionStore.getCustomTabValue(event.detail, STATE) || "null"
        );
      } catch {
        membership = null;
      }
      if (
        membership?.id !== record.id &&
        (membership || !this._joinsSite(event.detail, record))
      ) {
        this.makeManual(group);
      }
    } else if (record && event.type === "TabUngrouped") {
      const tab = event.detail;
      if (!tab.closing && !tab.hasAttribute("closing")) {
        this.exclude(tab);
      }
    }
    this.schedule();
  }

  exclude(tab) {
    SessionStore.setCustomTabValue(tab, EXCLUDED, "true");
    SessionStore.deleteCustomTabValue(tab, STATE);
  }

  makeManual(group) {
    this._groups.delete(group);
    group.removeAttribute("zen-auto-group");
    delete group.dataset.tooltip;
    for (const tab of group.tabs) {
      SessionStore.deleteCustomTabValue(tab, STATE);
    }
  }

  _allTabs() {
    return gZenWorkspaces.allStoredTabs ?? gBrowser.tabs;
  }

  _workspace(tab) {
    return tab.getAttribute("zen-workspace-id") || "";
  }

  _eligible(tab) {
    return (
      tab.isConnected &&
      !tab.closing &&
      !tab.hasAttribute("closing") &&
      !tab.pinned &&
      !tab.hasAttribute("zen-essential") &&
      !tab.hasAttribute("zen-empty-tab") &&
      !tab.hasAttribute("zen-glance-tab") &&
      !tab.group?.isZenFolder &&
      !tab.group?.hasAttribute("split-view-group") &&
      !SessionStore.getCustomTabValue(tab, EXCLUDED)
    );
  }

  _url(tab) {
    if (tab.hasAttribute("pending")) {
      const state = JSON.parse(SessionStore.getTabState(tab));
      return state.entries?.[(state.index || 1) - 1]?.url || "";
    }
    return tab.linkedBrowser.currentURI.spec;
  }

  /**
   * Whether a tab joining an automatic group without its membership (a link
   * opened from a tab of the group lands in it) belongs there: the group's
   * site, or not loaded yet (reconcile moves it out if it turns out another
   * site). Another site is the user's manual addition.
   */
  _joinsSite(tab, record) {
    const url = this._url(tab);
    if (!url || url === "about:blank") {
      return true;
    }
    try {
      const rules = parseAutoGroupRules(
        Services.prefs.getStringPref(`${PREF}excluded-domains`, ""),
        Services.prefs.getStringPref(`${PREF}path-rules`, "")
      );
      return autoGroupKey(url, rules, Services.eTLD)?.key === record.key;
    } catch {
      return false;
    }
  }

  _restoreGroups(tabs) {
    for (const tab of tabs) {
      const group = tab.group;
      if (
        !group ||
        group.isZenFolder ||
        group.hasAttribute("split-view-group") ||
        this._groups.has(group)
      ) {
        continue;
      }
      let record;
      try {
        record = JSON.parse(
          SessionStore.getCustomTabValue(tab, STATE) || "null"
        );
      } catch {
        continue;
      }
      if (
        record?.id === group.id &&
        typeof record.key === "string" &&
        record.name === group.label &&
        record.color === group.color &&
        record.workspace === this._workspace(tab)
      ) {
        this._groups.set(group, record);
        this._decorate(group);
      }
    }
  }

  _decorate(group) {
    group.setAttribute("zen-auto-group", "true");
    // Generated names can be truncated in a narrow sidebar; expose the full
    // name on hover (Zen otherwise clears group tooltips).
    group.dataset.tooltip = group.label;
    if (!group._zenAutoGroupContextMenu) {
      group._zenAutoGroupContextMenu = true;
      group.labelElement.addEventListener("contextmenu", event => {
        event.preventDefault();
        gBrowser.tabGroupMenu.openEditModal(group);
      });
    }
    const favicon = group.tabs.find(tab => tab.image)?.image;
    let image = group.querySelector(".zen-auto-group-icon");
    if (!image) {
      image = document.createXULElement("image");
      image.classList.add("zen-auto-group-icon");
      image.setAttribute("aria-hidden", "true");
      group.labelElement.before(image);
    }
    if (favicon) {
      image.setAttribute("src", favicon);
    } else {
      image.removeAttribute("src");
    }
    image.hidden = !favicon;
  }

  _animate(element) {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      element.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 150 });
    }
  }

  _persist(group, record) {
    record.name = `${record.key} (${group.tabs.length})`;
    group.label = record.name;
    const value = JSON.stringify(record);
    for (const tab of group.tabs) {
      if (SessionStore.getCustomTabValue(tab, STATE) !== value) {
        SessionStore.setCustomTabValue(tab, STATE, value);
      }
    }
    this._decorate(group);
  }

  _dissolve(group) {
    const tabs = [...group.tabs];
    this.makeManual(group);
    group.ungroupTabs();
    for (const tab of tabs) {
      this._animate(tab);
    }
  }

  // eslint-disable-next-line complexity
  reconcile() {
    if (
      !this._ready ||
      this._restoring ||
      this._changing ||
      window._zenClosingWindow
    ) {
      return;
    }
    const enabled = Services.prefs.getBoolPref(`${PREF}enabled`, true);
    let rules;
    try {
      rules = parseAutoGroupRules(
        enabled
          ? Services.prefs.getStringPref(`${PREF}excluded-domains`, "")
          : "",
        enabled ? Services.prefs.getStringPref(`${PREF}path-rules`, "") : ""
      );
    } catch (error) {
      console.error("Invalid URL auto-group preferences", error);
      return;
    }
    const threshold = Math.max(
      3,
      Math.min(10, Services.prefs.getIntPref(`${PREF}threshold`, 4))
    );
    const tabs = this._allTabs();
    this._changing = true;
    try {
      this._restoreGroups(tabs);
      const buckets = new Map();
      const keyFor = tab =>
        this._eligible(tab)
          ? autoGroupKey(this._url(tab), rules, Services.eTLD)
          : null;
      for (const [group, record] of this._groups) {
        if (!group.isConnected) {
          this._groups.delete(group);
          continue;
        }
        // Moving a whole group into a folder/pinned area is also a manual decision.
        if (group.pinned || group.group?.isZenFolder) {
          this.makeManual(group);
          continue;
        }
        const workspace = group.getAttribute("zen-workspace-id");
        if (
          workspace &&
          workspace !== record.workspace &&
          group.tabs.every(tab => this._workspace(tab) === workspace)
        ) {
          record.workspace = workspace;
        }
        for (const tab of [...group.tabs]) {
          if (tab.closing || tab.hasAttribute("closing")) {
            continue;
          }
          const key = keyFor(tab);
          if (
            !enabled ||
            !key ||
            key.key !== record.key ||
            this._workspace(tab) !== record.workspace
          ) {
            SessionStore.deleteCustomTabValue(tab, STATE);
            gBrowser.ungroupTab(tab);
          }
        }
        const members = group.tabs.filter(
          tab => !tab.closing && !tab.hasAttribute("closing")
        );
        if (!enabled || members.length <= 2) {
          this._dissolve(group);
        } else {
          buckets.set(JSON.stringify([record.workspace, record.key]), {
            group,
            record,
            tabs: [],
          });
        }
      }
      if (!enabled) {
        return;
      }
      for (const tab of tabs) {
        if (tab.group || !this._eligible(tab)) {
          continue;
        }
        const key = keyFor(tab);
        if (!key) {
          continue;
        }
        const workspace = this._workspace(tab);
        const id = JSON.stringify([workspace, key.key]);
        let bucket = buckets.get(id);
        if (!bucket) {
          bucket = { record: { ...key, workspace }, tabs: [] };
          buckets.set(id, bucket);
        }
        bucket.tabs.push(tab);
      }
      for (const bucket of buckets.values()) {
        let { group, record } = bucket;
        if (!group && bucket.tabs.length >= threshold) {
          group = gBrowser.addTabGroup(bucket.tabs, {
            insertBefore: bucket.tabs[0],
            color: record.color,
            label: `${record.key} (${bucket.tabs.length})`,
          });
          if (!group) {
            continue;
          }
          group.setAttribute("zen-workspace-id", record.workspace);
          record.id = group.id;
          this._groups.set(group, record);
          this._animate(group);
        } else if (group && bucket.tabs.length) {
          group.addTabs(bucket.tabs);
        }
        if (group) {
          this._persist(group, record);
        }
      }
    } finally {
      this._changing = false;
    }
  }
}

window.gZenAutoGroups = new ZenAutoGroups();
