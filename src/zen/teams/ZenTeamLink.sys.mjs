/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// B1/B2 in Nightly through Ombra (SERVER_DESIGN §7, decision 2026-10-18): Nightly has no team device of its own. It
// shares pages, tab groups and gallery screenshots, and learns what was shared with this member, through the Ombra
// running on this Mac, over the authenticated local Mach channel in ZenTeamLinkWorker.js: the runtime an Ombra embeds
// asks that Ombra (its own service name, NIGHTLY_TEAMS_SERVICE), a standalone Nightly the shared name. When Ombra does
// not run, cannot be verified or is not signed in to a team, every share action says why and stays disabled.

import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const WORKER_URL = "resource:///modules/zen/teams/ZenTeamLinkWorker.js";
const INBOX_AFTER_PREF = "zen.teams.inbox-after";
const INBOX_SKIP_PREF = "zen.teams.inbox-skip";
const INBOX_WAIT_MS = 25000;
const RETRY_MS = 10000;
const STATE_TTL_MS = 3000;

export const INCOMING_TOPIC = "zen-teams-incoming";
export const STATE_TOPIC = "zen-teams-state";

/**
 * The code requirement Ombra must satisfy: its Developer ID requirement (zen.embed.peer-requirement), else the code
 * directory hash Ombra wrote into this profile (zen.embed.peer-cdhash, an ad-hoc signed release); "" when neither.
 */
export function peerRequirement() {
  const requirement = Services.prefs.getStringPref(
    "zen.embed.peer-requirement",
    ""
  );
  if (requirement) {
    return requirement;
  }
  const cdhash = Services.prefs.getStringPref("zen.embed.peer-cdhash", "");
  return /^[0-9a-f]{40}$/.test(cdhash) ? `cdhash H"${cdhash}"` : "";
}

class Worker {
  #worker = null;
  #next = 1;
  #pending = new Map();

  call(json, timeoutMs) {
    if (!this.#worker) {
      this.#worker = new ChromeWorker(WORKER_URL);
      this.#worker.onmessage = ({ data }) => {
        const resolve = this.#pending.get(data.id);
        this.#pending.delete(data.id);
        resolve?.(data);
      };
      this.#worker.onerror = event => {
        event.preventDefault();
        for (const resolve of this.#pending.values()) {
          resolve({ error: "failed" });
        }
        this.#pending.clear();
        this.#worker = null;
      };
    }
    const id = this.#next++;
    return new Promise(resolve => {
      this.#pending.set(id, resolve);
      this.#worker.postMessage({
        id,
        json,
        timeoutMs,
        requirement: peerRequirement(),
        service: Services.env.get("NIGHTLY_TEAMS_SERVICE"),
        allowUnsigned: Services.prefs.getBoolPref(
          "zen.embed.allow-unsigned-peer",
          false
        ),
      });
    });
  }

  terminate() {
    this.#worker?.terminate();
    this.#worker = null;
    for (const resolve of this.#pending.values()) {
      resolve({ error: "failed" });
    }
    this.#pending.clear();
  }
}

/** Real transport: JSON request in, JSON answer (or {ok:false, error}) out. */
const rpc = new Worker();
const events = new Worker();
async function machTransport(request, { timeoutMs, longPoll }) {
  const answer = await (longPoll ? events : rpc).call(
    JSON.stringify(request),
    timeoutMs
  );
  if (answer.error) {
    return { ok: false, error: answer.error };
  }
  try {
    return JSON.parse(answer.text);
  } catch {
    return { ok: false, error: "failed" };
  }
}

class nsZenTeamLink {
  #transport = machTransport;
  #state = null;
  #stateAt = 0;
  #inboxRunning = false;
  #inboxGeneration = 0;

  /**
   * One request to Ombra.
   *
   * @param {string} op - state, share, inbox, open or decline.
   * @param {object} [args]
   * @returns {Promise<object>} Ombra's answer; {ok: false, error} on failure.
   */
  request(op, args = {}, { timeoutMs = 10000, longPoll = false } = {}) {
    return this.#transport({ op, ...args }, { timeoutMs, longPoll });
  }

  /**
   * Whether sharing is possible now and with whom.
   *
   * @returns {Promise<{ready: boolean, reason?: string, me?: string,
   *   teams?: Array<{id: string, title: string,
   *   members: Array<{id: string, name: string}>}>}>} reason: not-running,
   *   untrusted, signed-out, no-team, not-ready, no-members.
   */
  async state({ fresh = false } = {}) {
    if (!fresh && this.#state && Date.now() - this.#stateAt < STATE_TTL_MS) {
      return this.#state;
    }
    const answer = await this.request("state", {}, { timeoutMs: 3000 });
    let state;
    if (!answer.ok) {
      state = {
        ready: false,
        reason: answer.error === "untrusted" ? "untrusted" : "not-running",
      };
    } else if (!answer.ready) {
      state = { ready: false, reason: answer.reason || "not-ready" };
    } else if (!answer.teams?.some(team => team.members.length)) {
      state = { ready: false, reason: "no-members", teams: answer.teams };
    } else {
      state = { ready: true, me: answer.me, teams: answer.teams };
    }
    this.#setState(state);
    return state;
  }

  /** The last known state without asking (null before the first answer). */
  get cachedState() {
    return this.#state;
  }

  #setState(state) {
    const changed = JSON.stringify(state) !== JSON.stringify(this.#state);
    this.#state = state;
    this.#stateAt = Date.now();
    if (changed) {
      Services.obs.notifyObservers(null, STATE_TOPIC);
    }
  }

  /**
   * Shares through Ombra.
   *
   * @param {string} team - Team id.
   * @param {"all"|string[]} to - Everyone else in the team, or member ids.
   * @param {object} item - {kind: "link", url, title, comment} |
   *   {kind: "collection", title, links: [{url, title}], comment} |
   *   {kind: "screenshot", title, url, jpeg (base64), comment}.
   * @returns {Promise<object>} {ok, sent} or {ok: false, error, detail}.
   */
  share(team, to, item) {
    return this.request("share", { team, to, item }, { timeoutMs: 30000 });
  }

  open(item) {
    return this.request(
      "open",
      { team: item.team, author: item.author, id: item.id },
      { timeoutMs: 15000 }
    );
  }

  decline(item) {
    return this.request(
      "decline",
      { team: item.team, author: item.author, id: item.id },
      { timeoutMs: 15000 }
    );
  }

  /**
   * Starts the inbox long poll (once per process): every item shared with
   * this member that was not seen before is announced on INCOMING_TOPIC
   * (subject: null, data: the item as JSON). What was announced is remembered
   * in prefs, so a restart does not announce it again.
   */
  startInbox() {
    if (this.#inboxRunning) {
      return;
    }
    this.#inboxRunning = true;
    this.#pollInbox(++this.#inboxGeneration);
  }

  stopInbox() {
    this.#inboxRunning = false;
    this.#inboxGeneration++;
  }

  async #pollInbox(generation) {
    while (generation === this.#inboxGeneration) {
      const after = Number(Services.prefs.getStringPref(INBOX_AFTER_PREF, "0"));
      const skip = new Set(
        Services.prefs.getStringPref(INBOX_SKIP_PREF, "").split(" ").filter(Boolean)
      );
      const answer = await this.request(
        "inbox",
        { after, skip: [...skip], wait: INBOX_WAIT_MS },
        { timeoutMs: INBOX_WAIT_MS + 10000, longPoll: true }
      );
      if (generation !== this.#inboxGeneration) {
        return;
      }
      if (!answer.ok || answer.reason) {
        // Ombra is not running, not trusted, signed out or has no team:
        // nothing arrives until that changes.
        this.#setState({
          ready: false,
          reason: answer.ok
            ? answer.reason
            : answer.error === "untrusted"
              ? "untrusted"
              : "not-running",
        });
        await new Promise(resolve => setTimeout(resolve, RETRY_MS));
        continue;
      }
      let newest = after;
      let newestKeys = skip;
      for (const item of answer.items) {
        const key = `${item.author}/${item.id}`;
        if (
          item.createdAt < after ||
          (item.createdAt === after && skip.has(key))
        ) {
          continue;
        }
        if (item.createdAt > newest) {
          newest = item.createdAt;
          newestKeys = new Set();
        }
        newestKeys.add(key);
        Services.obs.notifyObservers(
          null,
          INCOMING_TOPIC,
          JSON.stringify(item)
        );
      }
      Services.prefs.setStringPref(INBOX_AFTER_PREF, String(newest));
      Services.prefs.setStringPref(INBOX_SKIP_PREF, [...newestKeys].join(" "));
    }
  }

  /** Tests: replaces the Mach transport; null restores it. */
  setTransportForTesting(transport) {
    this.#transport = transport || machTransport;
    this.#state = null;
    this.#stateAt = 0;
  }
}

export const ZenTeamLink = new nsZenTeamLink();

// On quit nothing may keep asking Ombra: a worker blocked in mach_msg would hold
// shutdown until its receive timeout, and the poll would start the next one.
Services.obs.addObserver(function onQuit() {
  Services.obs.removeObserver(onQuit, "quit-application-granted");
  ZenTeamLink.stopInbox();
  rpc.terminate();
  events.terminate();
}, "quit-application-granted");
