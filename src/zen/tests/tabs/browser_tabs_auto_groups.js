/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

const AUTO_PREF = "zen.tabs.auto-groups.";
const AUTO_STATE = "zen-auto-group";
const AUTO_EXCLUDED = "zen-auto-group-excluded";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.window-sync.enabled", false],
      ["zen.workspaces.continue-where-left-off", true],
      [AUTO_PREF + "enabled", true],
      [AUTO_PREF + "threshold", 4],
      [AUTO_PREF + "excluded-domains", ""],
      [AUTO_PREF + "path-rules", ""],
    ],
  });
});

async function autoGroupWindow(callback) {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  try {
    await TestUtils.waitForCondition(() => win.gZenAutoGroups?._ready);
    await callback(win);
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
}

async function autoGroupTabs(win, count, url = "https://example.com/") {
  const tabs = [];
  for (let index = 0; index < count; index++) {
    const tab = BrowserTestUtils.addTab(
      win.gBrowser,
      `${url}?auto-group=${index}`
    );
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    tabs.push(tab);
  }
  win.gZenAutoGroups.reconcile();
  return tabs;
}

add_task(async function test_site_and_path_policy() {
  const { autoGroupKey, parseAutoGroupRules } = ChromeUtils.importESModule(
    "chrome://browser/content/zen-components/ZenAutoGroupRules.mjs",
    { global: "current" }
  );
  const rules = parseAutoGroupRules(
    "excluded.co.uk",
    "github.com=1 example.com=2"
  );
  const key = url => autoGroupKey(url, rules, Services.eTLD);
  is(
    key("https://www.pinterest.com/a").key,
    "pinterest.com",
    "Uses public suffix service"
  );
  is(
    key("https://a.example.co.uk/a").key,
    "example.co.uk",
    "Multi-label suffix works"
  );
  is(
    key("https://github.com/org/repo?tab=1#readme").key,
    "github.com/org",
    "Organization path rule"
  );
  is(
    key("https://example.com/org/repo/issues").key,
    "example.com/org/repo",
    "Repository path rule"
  );
  isnot(
    key("https://github.com/Org/a").key,
    key("https://github.com/org/a").key,
    "Path case is preserved"
  );
  is(
    key("https://github.com/org/a").color,
    key("https://github.com/other/b").color,
    "Site color is stable"
  );
  is(
    key("https://a.excluded.co.uk/"),
    null,
    "Excluded registrable domain includes subdomains"
  );
  for (const url of [
    "about:blank",
    "file:///tmp/test",
    "https://127.0.0.1/",
    "http://localhost/",
    "invalid",
  ]) {
    is(key(url), null, `Does not group ${url}`);
  }
  Assert.throws(() => parseAutoGroupRules("", "github.com=0"), /Path rules/);
  Assert.throws(() => parseAutoGroupRules("https://example.com"), /domain/);
});

add_task(async function test_threshold_hysteresis_and_disable() {
  await autoGroupWindow(async win => {
    const tabs = await autoGroupTabs(win, 3);
    ok(
      tabs.every(tab => !tab.group),
      "Three tabs do not create a default group"
    );
    tabs.push(...(await autoGroupTabs(win, 1)));
    const group = tabs[0].group;
    ok(
      group?.hasAttribute("zen-auto-group"),
      "Fourth tab creates the native group"
    );
    is(group.tabs.length, 4, "All matching tabs collected");
    is(group.label, "example.com (4)", "Site and count label");
    await BrowserTestUtils.removeTab(tabs.pop());
    win.gZenAutoGroups.reconcile();
    is(tabs[0].group, group, "Three tabs retain the same group");
    await BrowserTestUtils.removeTab(tabs.pop());
    win.gZenAutoGroups.reconcile();
    ok(
      tabs.every(tab => !tab.group),
      "Two remaining tabs dissolve the group"
    );
    tabs.push(...(await autoGroupTabs(win, 2)));
    ok(tabs[0].group, "Four tabs collect again");
    await SpecialPowers.pushPrefEnv({ set: [[AUTO_PREF + "enabled", false]] });
    win.gZenAutoGroups.reconcile();
    ok(
      tabs.every(tab => !tab.group),
      "Disabling dissolves automatic groups without closing tabs"
    );
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function test_group_header_toggles_visible_children() {
  await autoGroupWindow(async win => {
    await SimpleTest.promiseFocus(win);
    const selected = win.gBrowser.selectedTab;
    const tabs = await autoGroupTabs(win, 4);
    const group = tabs[0].group;
    tabs[0].setAttribute("image", "chrome://branding/content/icon32.png");
    win.gZenAutoGroups.reconcile();
    const header = group.labelElement.parentElement;
    const icon = header.querySelector(".zen-auto-group-icon");
    const rect = element => element.getBoundingClientRect();
    const center = element => rect(element).y + rect(element).height / 2;
    ok(BrowserTestUtils.isVisible(tabs[0]), "Expanded group displays its tabs");
    Assert.lessOrEqual(
      Math.abs(center(icon) - center(group.labelElement)),
      1,
      "Favicon and label share the same row"
    );
    Assert.lessOrEqual(
      rect(icon).right,
      rect(group.labelElement).left,
      "Favicon precedes the label"
    );

    EventUtils.synthesizeMouseAtCenter(group.labelElement, {}, win);
    await TestUtils.waitForCondition(() => group.collapsed);
    ok(
      tabs.every(tab => !BrowserTestUtils.isVisible(tab)),
      "Click hides all child tabs"
    );
    is(
      group.labelElement.getAttribute("aria-expanded"),
      "false",
      "Collapsed state is accessible"
    );
    is(
      win.gBrowser.selectedTab,
      selected,
      "Collapsing does not change the active page"
    );

    EventUtils.synthesizeMouseAtCenter(header, {}, win);
    await TestUtils.waitForCondition(() => !group.collapsed);
    ok(
      tabs.every(tab => BrowserTestUtils.isVisible(tab)),
      "Second click restores child tabs"
    );
    is(
      group.labelElement.getAttribute("aria-expanded"),
      "true",
      "Expanded state is accessible"
    );

    Services.focus.setFocus(selected, Services.focus.FLAG_BYKEY);
    win.gBrowser.tabContainer.ariaFocusedItem = group.labelElement;
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
    await TestUtils.waitForCondition(() => group.collapsed);
    ok(
      tabs.every(tab => !BrowserTestUtils.isVisible(tab)),
      "Keyboard activation also hides children"
    );
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
    await TestUtils.waitForCondition(() => !group.collapsed);
    ok(
      tabs.every(tab => BrowserTestUtils.isVisible(tab)),
      "Keyboard activation expands again"
    );
    await BrowserTestUtils.switchTab(win.gBrowser, tabs[0]);
    EventUtils.synthesizeMouse(header, 12, rect(header).height / 2, {}, win);
    await TestUtils.waitForCondition(() => group.collapsed);
    ok(
      tabs.every(tab => !BrowserTestUtils.isVisible(tab)),
      "Chevron hides even the active child"
    );
    is(
      win.gBrowser.selectedTab,
      tabs[0],
      "Hiding the active child leaves its page selected"
    );
  });
});

add_task(async function test_real_collection_keys() {
  const { autoGroupKey, parseAutoGroupRules } = ChromeUtils.importESModule(
    "chrome://browser/content/zen-components/ZenAutoGroupRules.mjs",
    { global: "current" }
  );
  const rules = parseAutoGroupRules("", "github.com=1");
  const key = url => autoGroupKey(url, rules, Services.eTLD)?.key;
  // A GitHub working set: two organizations, issues/PRs/blob views and anchors.
  const github = [
    "https://github.com/mozilla/gecko-dev",
    "https://github.com/mozilla/gecko-dev/pull/12345/files#diff-1",
    "https://github.com/mozilla/pdf.js/issues?q=is%3Aopen",
    "https://github.com/mozilla/firefox-ios/blob/main/README.md#L10",
    "https://github.com/zen-browser/desktop/releases",
  ];
  Assert.deepEqual(
    github.map(key),
    [
      "github.com/mozilla",
      "github.com/mozilla",
      "github.com/mozilla",
      "github.com/mozilla",
      "github.com/zen-browser",
    ],
    "GitHub URLs collect per organization with path depth 1"
  );
  is(
    key("https://github.com/"),
    "github.com",
    "Site root keeps the bare site key"
  );
  // A Pinterest moodboard: pins, boards, ideas and the www/no-www split.
  const pinterest = [
    "https://www.pinterest.com/pin/1234567890/",
    "https://pinterest.com/ideas/interior-design/123/",
    "https://www.pinterest.com/someone/moodboard/",
    "https://de.pinterest.com/pin/42/",
  ];
  ok(
    pinterest.every(url => key(url) === "pinterest.com"),
    "All Pinterest subdomains share one site group"
  );
  is(
    key("https://www.pinterest.co.uk/pin/1/"),
    "pinterest.co.uk",
    "Country domains are distinct registrable sites"
  );
  is(
    key("https://i.pinimg.com/originals/a.jpg"),
    "pinimg.com",
    "Image CDN is a separate site"
  );
});

add_task(async function test_live_collections_group_by_rule() {
  await SpecialPowers.pushPrefEnv({
    set: [[AUTO_PREF + "path-rules", "example.org=1"]],
  });
  await autoGroupWindow(async win => {
    const repos = [];
    for (const path of [
      "mozilla/a",
      "mozilla/b/issues?q=1",
      "mozilla/c/pull/1#files",
      "mozilla/d",
    ]) {
      repos.push(
        ...(await autoGroupTabs(win, 1, `https://example.org/${path}`))
      );
    }
    const others = [];
    for (const path of ["other/a", "other/b"]) {
      others.push(
        ...(await autoGroupTabs(win, 1, `https://example.org/${path}`))
      );
    }
    const pins = [];
    for (const host of [
      "www.example.com",
      "example.com",
      "test1.example.com",
      "sub1.test1.example.com",
    ]) {
      pins.push(...(await autoGroupTabs(win, 1, `https://${host}/pin/1`)));
    }
    win.gZenAutoGroups.reconcile();
    const repoGroup = repos[0].group;
    ok(
      repoGroup?.hasAttribute("zen-auto-group"),
      "Organization collection forms an automatic group"
    );
    ok(
      repos.every(tab => tab.group === repoGroup),
      "Query, hash and deeper paths stay in the organization group"
    );
    is(
      repoGroup.label,
      "example.org/mozilla (4)",
      "Organization group label uses the path rule"
    );
    ok(
      others.every(tab => !tab.group),
      "A second organization below threshold stays ungrouped"
    );
    const pinGroup = pins[0].group;
    ok(
      pinGroup && pins.every(tab => tab.group === pinGroup),
      "www, bare and nested subdomains share one site group"
    );
    is(pinGroup.label, "example.com (4)", "Site group label");
    isnot(pinGroup, repoGroup, "Different sites never share a group");
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_long_name_in_narrow_sidebar() {
  const segment = "very-long-organization-name-for-layout";
  await SpecialPowers.pushPrefEnv({
    set: [[AUTO_PREF + "path-rules", "example.com=2"]],
  });
  await autoGroupWindow(async win => {
    await SimpleTest.promiseFocus(win);
    const tabs = await autoGroupTabs(
      win,
      4,
      `https://example.com/${segment}/${segment}-repository`
    );
    const group = tabs[0].group;
    tabs[0].setAttribute("image", "chrome://branding/content/icon32.png");
    win.gZenAutoGroups.reconcile();
    const fullName = `example.com/${segment}/${segment}-repository (4)`;
    is(
      group.label,
      fullName,
      "Long automatic name is kept intact in the model"
    );
    const toolbox = win.gNavToolbox;
    const original = toolbox.style.width;
    try {
      for (const width of ["163px", "120px"]) {
        toolbox.style.width = width;
        toolbox.style.setProperty("--zen-sidebar-width", width);
        await new Promise(resolve =>
          win.requestAnimationFrame(() => win.requestAnimationFrame(resolve))
        );
        const header = group.labelElement.parentElement;
        const label = group.labelElement;
        const icon = header.querySelector(".zen-auto-group-icon");
        const rect = element => element.getBoundingClientRect();
        const style = win.getComputedStyle(label);
        const tabRect = rect(tabs[0]);
        // 120px is below --zen-toolbox-min-width, so the sidebar clamps.
        Assert.greaterOrEqual(
          rect(toolbox).width,
          163,
          `${width}: sidebar respects its minimum width`
        );
        info(
          `${width}: toolbox ${rect(toolbox).width}, header ${rect(header).width}x${rect(header).height}, label ${label.clientWidth}/${label.scrollWidth}`
        );
        Assert.lessOrEqual(
          rect(header).height,
          tabRect.height + 1,
          `${width}: long name stays on one row`
        );
        Assert.lessOrEqual(
          rect(header).right,
          rect(toolbox).right + 0.5,
          `${width}: header does not overflow the sidebar`
        );
        Assert.lessOrEqual(
          rect(label).right,
          rect(header).right,
          `${width}: label is clipped inside its header`
        );
        Assert.greater(
          label.scrollWidth,
          label.clientWidth,
          `${width}: long name is truncated`
        );
        is(
          style.textOverflow,
          "ellipsis",
          `${width}: truncation uses an ellipsis`
        );
        is(rect(icon).width, 16, `${width}: favicon keeps its size`);
        Assert.greaterOrEqual(
          rect(icon).left - rect(header).left,
          8 + 5,
          `${width}: chevron space precedes the favicon`
        );
        Assert.greater(
          label.clientWidth,
          0,
          `${width}: some label text stays visible`
        );
        Assert.lessOrEqual(
          tabRect.right,
          rect(toolbox).right + 0.5,
          `${width}: child tabs fit the sidebar`
        );
      }
      is(
        group.labelElement.getAttribute("tooltiptext"),
        fullName,
        "Full name stays available as the header tooltip"
      );
      EventUtils.synthesizeMouseAtCenter(group.labelElement, {}, win);
      await TestUtils.waitForCondition(() => group.collapsed);
      ok(
        tabs.every(tab => !BrowserTestUtils.isVisible(tab)),
        "Narrow collapsed header hides children"
      );
      EventUtils.synthesizeMouseAtCenter(group.labelElement, {}, win);
      await TestUtils.waitForCondition(() => !group.collapsed);
      group.label = "Renamed";
      ok(
        !group.labelElement.getAttribute("tooltiptext"),
        "Manual rename drops the generated tooltip"
      );
    } finally {
      toolbox.style.width = original;
      toolbox.style.setProperty("--zen-sidebar-width", original);
    }
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_manual_extraction_rename_and_color() {
  await autoGroupWindow(async win => {
    const tabs = await autoGroupTabs(win, 5);
    const group = tabs[0].group;
    win.gBrowser.ungroupTab(tabs[0]);
    win.gZenAutoGroups.reconcile();
    ok(!tabs[0].group, "Extracted tab is not reabsorbed");
    is(
      SessionStore.getCustomTabValue(tabs[0], AUTO_EXCLUDED),
      "true",
      "Extraction is persisted"
    );
    await autoGroupTabs(win, 1);
    ok(!tabs[0].group, "New matching tab does not reabsorb the extracted tab");
    group.label = "My references";
    ok(
      !group.hasAttribute("zen-auto-group"),
      "Rename converts group to manual"
    );
    for (const tab of group.tabs.slice(2)) {
      await BrowserTestUtils.removeTab(tab);
    }
    win.gZenAutoGroups.reconcile();
    is(group.tabs.length, 2, "Manual group remains at two");
    is(group.label, "My references", "Manual name is untouched");
    ok(
      group.tabs.every(tab => !SessionStore.getCustomTabValue(tab, AUTO_STATE)),
      "Automatic state removed from manual group"
    );
    const colored = await autoGroupTabs(win, 4, "https://example.org/");
    const colorGroup = colored[0].group;
    colorGroup.color = colorGroup.color === "red" ? "blue" : "red";
    win.gZenAutoGroups.reconcile();
    ok(
      !colorGroup.hasAttribute("zen-auto-group"),
      "Recolor also makes the group manual"
    );
  });
});

add_task(async function test_manual_addition_preserves_the_added_tab() {
  await autoGroupWindow(async win => {
    const tabs = await autoGroupTabs(win, 4);
    const group = tabs[0].group;
    const [added] = await autoGroupTabs(win, 1, "https://example.org/");
    group.addTabs([added]);
    win.gZenAutoGroups.reconcile();
    is(added.group, group, "A manual cross-site addition is not undone");
    ok(
      !group.hasAttribute("zen-auto-group"),
      "Manually extended group becomes manual"
    );
  });
});

add_task(async function test_whole_group_workspace_move_preserves_identity() {
  await autoGroupWindow(async win => {
    const tabs = await autoGroupTabs(win, 4);
    const group = tabs[0].group;
    await BrowserTestUtils.removeTab(tabs.pop());
    win.gZenAutoGroups.reconcile();
    await win.gZenWorkspaces.createAndSaveWorkspace("Moved group");
    const target = win.gZenWorkspaces.activeWorkspace;
    win.gZenFolders.changeFolderToSpace(group, target);
    win.gZenAutoGroups.reconcile();
    ok(
      tabs.every(tab => tab.group === group),
      "Moving a three-tab group keeps the same group"
    );
    ok(
      tabs.every(tab => tab.getAttribute("zen-workspace-id") === target),
      "All tabs move together"
    );
  });
});

add_task(async function test_workspace_and_manual_exceptions() {
  await autoGroupWindow(async win => {
    await SpecialPowers.pushPrefEnv({ set: [[AUTO_PREF + "enabled", false]] });
    const first = await autoGroupTabs(win, 3);
    const pinned = (await autoGroupTabs(win, 1))[0];
    win.gBrowser.pinTab(pinned);
    const folderTabs = await autoGroupTabs(win, 2);
    const folder = await win.gZenFolders.createFolder(folderTabs, {
      renameFolder: false,
      label: "Keep",
    });
    const manualTabs = await autoGroupTabs(win, 2);
    const manual = win.gBrowser.addTabGroup(manualTabs, {
      label: "Manual",
      insertBefore: manualTabs[0],
    });
    const firstWorkspace = win.gZenWorkspaces.activeWorkspace;
    await win.gZenWorkspaces.createAndSaveWorkspace("Auto-group isolation");
    const second = await autoGroupTabs(win, 3);
    await SpecialPowers.popPrefEnv();
    win.gZenAutoGroups.reconcile();
    ok(
      first.every(tab => !tab.group) && second.every(tab => !tab.group),
      "Three plus three across workspaces do not collect"
    );
    second.push(...(await autoGroupTabs(win, 1)));
    ok(
      second.every(tab => tab.group === second[0].group),
      "Second workspace groups independently"
    );
    ok(
      first.every(tab => !tab.group),
      "First workspace remains unchanged"
    );
    ok(
      first.every(
        tab => tab.getAttribute("zen-workspace-id") === firstWorkspace
      ),
      "Workspace ownership preserved"
    );
    ok(pinned.pinned && !pinned.group, "Pinned tab excluded");
    ok(
      folderTabs.every(tab => tab.group === folder),
      "Folder tabs untouched"
    );
    ok(
      manualTabs.every(tab => tab.group === manual),
      "Manual group untouched"
    );
  });
});

add_task(async function test_preferences_and_navigation() {
  await autoGroupWindow(async win => {
    await SpecialPowers.pushPrefEnv({
      set: [
        [AUTO_PREF + "threshold", 3],
        [AUTO_PREF + "excluded-domains", "example.org"],
      ],
    });
    const tabs = await autoGroupTabs(win, 3);
    ok(tabs[0].group, "Custom threshold is honored");
    const excluded = await autoGroupTabs(win, 4, "https://example.org/");
    ok(
      excluded.every(tab => !tab.group),
      "Domain preference prevents grouping"
    );
    const loaded = BrowserTestUtils.browserLoaded(tabs[0].linkedBrowser);
    BrowserTestUtils.startLoadingURIString(
      tabs[0].linkedBrowser,
      "https://example.org/"
    );
    await loaded;
    win.gZenAutoGroups.reconcile();
    ok(
      tabs.every(tab => !tab.group),
      "Navigation removes member and dissolves remaining two"
    );
    ok(
      !SessionStore.getCustomTabValue(tabs[0], AUTO_EXCLUDED),
      "Automatic removal is not manual extraction"
    );
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function test_session_round_trip() {
  await autoGroupWindow(async win => {
    const tabs = await autoGroupTabs(win, 5);
    win.gBrowser.ungroupTab(tabs[0]);
    win.gZenAutoGroups.reconcile();
    const groupId = tabs[1].group.id;
    const manualTabs = await autoGroupTabs(win, 4, "https://example.org/");
    const manualId = manualTabs[0].group.id;
    manualTabs[0].group.label = "Saved manual references";
    const { TabStateFlusher } = ChromeUtils.importESModule(
      "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs"
    );
    await TabStateFlusher.flushWindow(win);
    const state = SessionStore.getWindowState(win);
    const ready = BrowserTestUtils.waitForEvent(win, "SSWindowStateReady");
    SessionStore.setWindowState(win, state, true);
    await ready;
    const manual = win.gBrowser.tabGroups.find(item => item.id === manualId);
    is(
      manual.label,
      "Saved manual references",
      "Manual name survives session restore"
    );
    ok(
      !manual.hasAttribute("zen-auto-group"),
      "Restored renamed group stays manual"
    );
    win.gZenAutoGroups.reconcile();
    const restored = win.gZenWorkspaces.allStoredTabs.filter(tab =>
      SessionStore.getCustomTabValue(tab, AUTO_EXCLUDED)
    );
    is(
      restored.length,
      1,
      "Manual exclusion survives actual SessionStore restore"
    );
    ok(!restored[0].group, "Excluded restored tab stays outside");
    const group = win.gBrowser.tabGroups.find(item => item.id === groupId);
    ok(
      group?.hasAttribute("zen-auto-group"),
      "Restored group keeps its automatic identity"
    );
    is(group.tabs.length, 4, "Restore does not absorb excluded member");
    const automaticState = JSON.parse(
      SessionStore.getCustomTabValue(group.tabs[0], AUTO_STATE)
    );
    is(
      automaticState.workspace,
      group.tabs[0].getAttribute("zen-workspace-id"),
      "Workspace persists with automatic state"
    );
    for (const tab of group.tabs.slice(2)) {
      await BrowserTestUtils.removeTab(tab);
    }
    win.gZenAutoGroups.reconcile();
    ok(!group.tabs.length, "Restored automatic group still dissolves at two");
  });
});
