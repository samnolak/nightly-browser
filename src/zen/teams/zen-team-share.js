/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// The "Share with Team" dialog (ZenTeamsUI.openShareDialog): what is shared, an optional comment, the team and the
// recipients (everyone else in the team, or chosen members, as Ombra names them). Send shares through Ombra and
// closes; on failure the dialog stays open and says why.
{
  const { ZenTeamLink } = ChromeUtils.importESModule(
    "resource:///modules/zen/teams/ZenTeamLink.sys.mjs"
  );
  const { secretParams, stripSecrets } = ChromeUtils.importESModule(
    "resource:///modules/zen/teams/ZenTeamsUI.sys.mjs"
  );

  /** The item's addresses: the page's, or every tab's of a group. */
  function urlsOf(item) {
    return item.kind === "collection"
      ? item.links.map(link => link.url)
      : [item.url].filter(Boolean);
  }

  /** The item with secret-looking URL parameters removed. */
  function stripped(item) {
    if (item.kind === "collection") {
      return {
        ...item,
        links: item.links.map(link => ({ ...link, url: stripSecrets(link.url) })),
      };
    }
    return item.url ? { ...item, url: stripSecrets(item.url) } : item;
  }
  const args = window.arguments?.[0] || {};
  const $ = id => document.getElementById(id);

  function selectedTeam() {
    return args.state.teams.find(t => t.id === $("zen-team-share-team").value);
  }

  function recipients() {
    if ($("zen-team-share-to-all").checked) {
      return "all";
    }
    return [
      ...$("zen-team-share-members").querySelectorAll("input:checked"),
    ].map(input => input.value);
  }

  function update() {
    const toMembers = $("zen-team-share-to-members").checked;
    const members = $("zen-team-share-members");
    members.toggleAttribute("disabled", !toMembers);
    for (const input of members.querySelectorAll("input")) {
      input.disabled = !toMembers;
    }
    const to = recipients();
    document.querySelector("dialog").getButton("accept").disabled =
      sending || (to !== "all" && !to.length);
  }

  function showTeam() {
    const team = selectedTeam();
    document.l10n.setAttributes(
      $("zen-team-share-to-all-label"),
      "zen-team-share-to-all",
      { count: team.members.length }
    );
    const list = $("zen-team-share-members");
    list.replaceChildren();
    for (const member of team.members) {
      const label = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "label"
      );
      const input = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "input"
      );
      input.type = "checkbox";
      input.value = member.id;
      input.addEventListener("change", update);
      label.append(input, member.name);
      label.title = member.id;
      list.append(label);
    }
    update();
  }

  let sending = false;

  async function send(event) {
    event.preventDefault();
    if (sending) {
      return;
    }
    const to = recipients();
    if (to !== "all" && !to.length) {
      return;
    }
    sending = true;
    update();
    const status = $("zen-team-share-status");
    status.classList.remove("error");
    document.l10n.setAttributes(status, "zen-team-share-sending");
    const comment = $("zen-team-share-comment").value.trim();
    let item = { ...args.item };
    if (!$("zen-team-share-secrets").hidden && $("zen-team-share-strip").checked) {
      item = stripped(item);
    }
    if (comment) {
      item.comment = comment;
    }
    const answer = await ZenTeamLink.share(selectedTeam().id, to, item);
    sending = false;
    if (answer.ok) {
      args.sent = answer.sent;
      window.close();
      return;
    }
    status.classList.add("error");
    document.l10n.setAttributes(status, "zen-team-share-failed", {
      reason: answer.error,
      detail: answer.detail || "",
    });
    update();
  }

  window.addEventListener(
    "load",
    () => {
      const { item, state } = args;
      const what = $("zen-team-share-what-text");
      if (item.kind === "collection") {
        document.l10n.setAttributes(what, "zen-team-share-what-collection", {
          title: item.title,
          count: item.links.length,
        });
      } else {
        document.l10n.setAttributes(what, `zen-team-share-what-${item.kind}`, {
          title: item.title,
        });
      }
      const secrets = [...new Set(urlsOf(item).flatMap(secretParams))];
      if (secrets.length) {
        document.l10n.setAttributes(
          $("zen-team-share-secrets-text"),
          "zen-team-share-secrets",
          { names: secrets.join(", ") }
        );
        $("zen-team-share-secrets").hidden = false;
      }
      if (item.kind === "screenshot") {
        const preview = $("zen-team-share-preview");
        preview.src = `data:image/jpeg;base64,${item.jpeg}`;
        preview.hidden = false;
      }
      const teams = $("zen-team-share-team");
      for (const team of state.teams.filter(t => t.members.length)) {
        teams.append(new Option(team.title, team.id));
      }
      $("zen-team-share-team-row").hidden = teams.options.length < 2;
      teams.addEventListener("change", showTeam);
      $("zen-team-share-to-all").addEventListener("change", update);
      $("zen-team-share-to-members").addEventListener("change", update);
      document.addEventListener("dialogaccept", send);
      showTeam();
      $("zen-team-share-comment").focus();
      // SubDialog sized the frame for the document as it loaded; the page
      // line, members and notes filled in since (translated asynchronously)
      // make it taller, which would cut off the Share and Cancel buttons.
      document.l10n.translateRoots().then(() => window.resizeDialog?.());
    },
    { once: true }
  );
}
