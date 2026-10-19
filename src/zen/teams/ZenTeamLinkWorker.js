/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env worker */
/* global ctypes */

"use strict";

// The Nightly end of Ombra's team link (Ombra: avalonia/src/Ombra.App/Nightly/NightlyTeamLink.cs). Nightly has no team
// device of its own: it asks the Ombra running on this Mac, over a Mach bootstrap service, to share and to list what
// was shared with this member. The service is SERVICE for a standalone Nightly, or the embedding Ombra's own name
// (NIGHTLY_TEAMS_SERVICE, passed in by ZenTeamLink.sys.mjs as `service`) for the runtime an Ombra embeds. One request
// at a time per worker; the call blocks this thread until Ombra
// answers or the timeout passes (the inbox long poll as well), never the main thread.
//
// Message (both directions): mach_msg_header_t, then u32 version, u32 length, UTF-8 JSON. A request carries a
// send-once right to a fresh receive port; the answer comes back on it. The answer counts only when its sender, by
// the kernel's audit token, is this user and passes Ombra's code requirement (ZenTeamLink's peerRequirement(): the
// Developer ID requirement zen.embed.peer-requirement, else `cdhash H"…"` from zen.embed.peer-cdhash, the hash Ombra
// writes into its runtime profile; as for the embed channel), or the development pref zen.embed.allow-unsigned-peer
// is set and no requirement is. A request with
// content is sent only to a service port whose receiver has already passed that check on a content-free handshake
// ({op: "state"}); the worker keeps that port and never looks the name up again between the check and a send.

const SERVICE = "com.ombra.nightly-teams";
const VERSION = 1;
const REQUEST_ID = 0x4f540001;
const REPLY_ID = 0x4f540002;
const MAX_JSON = 768 * 1024;
const BUFFER_SIZE = MAX_JSON + 1024;
const TRAILER_SIZE = 52; // mach_msg_audit_trailer_t

const MACH_SEND_MSG = 0x1;
const MACH_RCV_MSG = 0x2;
const MACH_SEND_TIMEOUT = 0x10;
const MACH_RCV_TIMEOUT = 0x100;
const MACH_RCV_TIMED_OUT = 0x10004003;
// MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) | MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT)
const MACH_RCV_AUDIT_TRAILER = 3 << 24;
const MACH_MSG_TYPE_COPY_SEND = 19;
const MACH_MSG_TYPE_MAKE_SEND_ONCE = 21;
const MACH_PORT_RIGHT_RECEIVE = 1;
const kCFStringEncodingUTF8 = 0x08000100;

const port_t = ctypes.uint32_t;
const libc = ctypes.open("/usr/lib/libSystem.B.dylib");
const cf = ctypes.open(
  "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
);
const sec = ctypes.open(
  "/System/Library/Frameworks/Security.framework/Security"
);

const bootstrapPort = libc.declare("bootstrap_port", port_t);
const taskSelf = libc.declare("mach_task_self_", port_t);
const bootstrap_look_up = libc.declare(
  "bootstrap_look_up",
  ctypes.default_abi,
  ctypes.int,
  port_t,
  ctypes.char.ptr,
  port_t.ptr
);
const mach_port_allocate = libc.declare(
  "mach_port_allocate",
  ctypes.default_abi,
  ctypes.int,
  port_t,
  ctypes.int,
  port_t.ptr
);
const mach_port_mod_refs = libc.declare(
  "mach_port_mod_refs",
  ctypes.default_abi,
  ctypes.int,
  port_t,
  port_t,
  ctypes.int,
  ctypes.int
);
const mach_port_deallocate = libc.declare(
  "mach_port_deallocate",
  ctypes.default_abi,
  ctypes.int,
  port_t,
  port_t
);
const mach_msg = libc.declare(
  "mach_msg",
  ctypes.default_abi,
  ctypes.int,
  ctypes.voidptr_t,
  ctypes.int,
  ctypes.uint32_t,
  ctypes.uint32_t,
  port_t,
  ctypes.uint32_t,
  port_t
);
const memcpy = libc.declare(
  "memcpy",
  ctypes.default_abi,
  ctypes.voidptr_t,
  ctypes.voidptr_t,
  ctypes.voidptr_t,
  ctypes.size_t
);
const geteuid = libc.declare("geteuid", ctypes.default_abi, ctypes.uint32_t);

const CFRelease = cf.declare(
  "CFRelease",
  ctypes.default_abi,
  ctypes.void_t,
  ctypes.voidptr_t
);
const CFDataCreate = cf.declare(
  "CFDataCreate",
  ctypes.default_abi,
  ctypes.voidptr_t,
  ctypes.voidptr_t,
  ctypes.voidptr_t,
  ctypes.long
);
const CFDictionaryCreate = cf.declare(
  "CFDictionaryCreate",
  ctypes.default_abi,
  ctypes.voidptr_t,
  ctypes.voidptr_t,
  ctypes.voidptr_t.ptr,
  ctypes.voidptr_t.ptr,
  ctypes.long,
  ctypes.voidptr_t,
  ctypes.voidptr_t
);
const CFStringCreateWithCString = cf.declare(
  "CFStringCreateWithCString",
  ctypes.default_abi,
  ctypes.voidptr_t,
  ctypes.voidptr_t,
  ctypes.char.ptr,
  ctypes.uint32_t
);
const keyCallBacks = cf.declare("kCFTypeDictionaryKeyCallBacks", ctypes.uint8_t);
const valueCallBacks = cf.declare(
  "kCFTypeDictionaryValueCallBacks",
  ctypes.uint8_t
);
const kSecGuestAttributeAudit = sec.declare(
  "kSecGuestAttributeAudit",
  ctypes.voidptr_t
);
const SecCodeCopyGuestWithAttributes = sec.declare(
  "SecCodeCopyGuestWithAttributes",
  ctypes.default_abi,
  ctypes.int,
  ctypes.voidptr_t,
  ctypes.voidptr_t,
  ctypes.uint32_t,
  ctypes.voidptr_t.ptr
);
const SecRequirementCreateWithString = sec.declare(
  "SecRequirementCreateWithString",
  ctypes.default_abi,
  ctypes.int,
  ctypes.voidptr_t,
  ctypes.uint32_t,
  ctypes.voidptr_t.ptr
);
const SecCodeCheckValidity = sec.declare(
  "SecCodeCheckValidity",
  ctypes.default_abi,
  ctypes.int,
  ctypes.voidptr_t,
  ctypes.uint32_t,
  ctypes.voidptr_t
);

const replyBuffer = ctypes.uint8_t.array(BUFFER_SIZE)();

function release(ref) {
  if (ref && !ref.isNull()) {
    CFRelease(ref);
  }
}

/** Whether the process the audit token names satisfies the code requirement text. */
function satisfies(tokenAddress, requirementText) {
  let data, attributes, code, text, requirement;
  try {
    data = CFDataCreate(null, tokenAddress, 32);
    // The exported CFStringRef itself (a pointer CData has no .value).
    const keys = ctypes.voidptr_t.array(1)([kSecGuestAttributeAudit]);
    const values = ctypes.voidptr_t.array(1)([data]);
    attributes = CFDictionaryCreate(
      null,
      keys,
      values,
      1,
      keyCallBacks.address(),
      valueCallBacks.address()
    );
    const guest = new ctypes.voidptr_t();
    if (SecCodeCopyGuestWithAttributes(null, attributes, 0, guest.address())) {
      return false;
    }
    code = guest;
    text = CFStringCreateWithCString(
      null,
      requirementText,
      kCFStringEncodingUTF8
    );
    const req = new ctypes.voidptr_t();
    if (SecRequirementCreateWithString(text, 0, req.address())) {
      return false;
    }
    requirement = req;
    return SecCodeCheckValidity(code, 0, requirement) === 0;
  } finally {
    release(requirement);
    release(text);
    release(code);
    release(attributes);
    release(data);
  }
}

function message(json) {
  const text = new TextEncoder().encode(json);
  const size = 32 + ((text.length + 3) & ~3);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MACH_MSG_TYPE_COPY_SEND | (MACH_MSG_TYPE_MAKE_SEND_ONCE << 8), true);
  view.setUint32(4, size, true);
  view.setUint32(20, REQUEST_ID, true);
  view.setUint32(24, VERSION, true);
  view.setUint32(28, text.length, true);
  bytes.set(text, 32);
  return { bytes, view, size, tooLarge: text.length > MAX_JSON };
}

// The service port of the Ombra this worker verified (0: none yet). bootstrap_look_up only says who holds the name
// now: after Ombra quits, any local process of this user may register it. So a request with content goes only to a
// port whose receiver already answered a request without content (the handshake) and passed the audit-token check;
// that receiver keeps the port's receive right for its life, and the port dies with it.
let pinned = 0;
const HANDSHAKE = JSON.stringify({ op: "state" });
const MACH_SEND_INVALID_DEST = 0x10000003;

function unpin() {
  if (pinned) {
    mach_port_deallocate(taskSelf.value, pinned);
    pinned = 0;
  }
}

/**
 * Sends one message to `service` and waits for its answer; the answer counts
 * only from this user's Ombra (the audit token).
 *
 * @returns {{text?: string, error?: string, dead?: boolean}} `dead`: the
 *   message could not be sent to the port (its receiver is gone).
 */
function exchange(service, out, { timeoutMs, requirement, allowUnsigned }) {
  const reply = new port_t();
  if (
    mach_port_allocate(
      taskSelf.value,
      MACH_PORT_RIGHT_RECEIVE,
      reply.address()
    )
  ) {
    return { error: "failed" };
  }
  try {
    out.view.setUint32(8, service, true);
    out.view.setUint32(12, reply.value, true);
    let kr = mach_msg(
      out.bytes,
      MACH_SEND_MSG | MACH_SEND_TIMEOUT,
      out.size,
      0,
      0,
      2000,
      0
    );
    if (kr) {
      return { error: "not-running", dead: kr === MACH_SEND_INVALID_DEST };
    }
    kr = mach_msg(
      replyBuffer.address(),
      MACH_RCV_MSG | MACH_RCV_TIMEOUT | MACH_RCV_AUDIT_TRAILER,
      0,
      BUFFER_SIZE - TRAILER_SIZE,
      reply.value,
      timeoutMs,
      0
    );
    if (kr === MACH_RCV_TIMED_OUT) {
      return { error: "timeout" };
    }
    if (kr) {
      return { error: "failed" };
    }
    const header = new Uint8Array(36);
    memcpy(header, replyBuffer.address(), 36);
    const view = new DataView(header.buffer);
    const size = view.getUint32(4, true);
    // Ombra dropped the reply right (it refused this Nightly): the kernel's
    // send-once notification arrives instead of an answer.
    if (view.getUint32(20, true) !== REPLY_ID || size < 32) {
      return { error: "not-running" };
    }
    const tokenOffset = ((size + 3) & ~3) + 20;
    const token = new Uint32Array(8);
    memcpy(token, replyBuffer.addressOfElement(tokenOffset), 32);
    // audit_token_t: val[1] is the effective uid.
    const trusted =
      token[1] === geteuid() &&
      (requirement
        ? satisfies(replyBuffer.addressOfElement(tokenOffset), requirement)
        : allowUnsigned);
    if (!trusted) {
      return { error: "untrusted" };
    }
    const length = view.getUint32(28, true);
    if (view.getUint32(24, true) !== VERSION || 32 + length > size) {
      return { error: "failed" };
    }
    const body = new Uint8Array(length);
    if (length) {
      memcpy(body, replyBuffer.addressOfElement(32), length);
    }
    return { text: new TextDecoder().decode(body) };
  } finally {
    mach_port_mod_refs(taskSelf.value, reply.value, MACH_PORT_RIGHT_RECEIVE, -1);
  }
}

/**
 * Looks `name` up and authenticates its receiver with the handshake
 * (no content of the user's in it); pins the port when it is Ombra.
 *
 * @returns {{error?: string}}
 */
function connect(name, options) {
  const service = new port_t();
  if (bootstrap_look_up(bootstrapPort.value, name, service.address())) {
    return { error: "not-running" };
  }
  const answer = exchange(service.value, message(HANDSHAKE), options);
  if (answer.error) {
    mach_port_deallocate(taskSelf.value, service.value);
    return { error: answer.error };
  }
  pinned = service.value;
  return {};
}

/**
 * Sends one request and waits for its answer. The request goes only to the
 * pinned, verified Ombra; without one (or when it is gone) this first
 * connects and authenticates, and sends nothing when that fails.
 *
 * @returns {{text?: string, error?: string}} The answer's JSON text, or why
 *   there is none: "not-running" (no Ombra service, or it refused this
 *   Nightly), "untrusted" (the service is not Ombra), "timeout",
 *   "failed".
 */
function request({ json, timeoutMs, requirement, allowUnsigned, service }) {
  const out = message(json);
  if (out.tooLarge) {
    return { error: "too-large" };
  }
  const options = { timeoutMs, requirement, allowUnsigned };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!pinned) {
      const connected = connect(service || SERVICE, {
        ...options,
        timeoutMs: Math.min(timeoutMs, 3000),
      });
      if (connected.error) {
        return connected;
      }
    }
    const answer = exchange(pinned, out, options);
    if (answer.dead && attempt === 0) {
      unpin(); // Ombra quit since: authenticate whoever has the name now
      continue;
    }
    if (answer.error === "untrusted" || answer.dead) {
      unpin();
    }
    return answer.error ? { error: answer.error } : { text: answer.text };
  }
  return { error: "not-running" };
}

self.onmessage = ({ data }) => {
  let result;
  try {
    result = request(data);
  } catch (e) {
    result = { error: "failed", detail: String(e) };
  }
  self.postMessage({ id: data.id, ...result });
};
