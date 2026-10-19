/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const COLORS = ["blue", "purple", "cyan", "orange", "yellow", "pink", "green", "red"];

function domainName(value) {
  const url = new URL(`https://${value}`);
  if (url.host !== url.hostname || url.pathname !== "/" || url.search ||
      url.hash || url.username || url.password || !url.hostname.includes(".")) {
    throw new Error("Enter a domain, not a URL.");
  }
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

// Text preferences are intentionally human-editable; no regexes or executable rules.
export function parseAutoGroupRules(exclusions = "", paths = "") {
  const excluded = new Set();
  const depths = new Map();
  for (const value of exclusions.split(/[\s,]+/).filter(Boolean)) {
    excluded.add(domainName(value));
  }
  for (const value of paths.split(/[\s,]+/).filter(Boolean)) {
    const match = /^([^=]+)=([1-5])$/.exec(value);
    if (!match) {
      throw new Error("Path rules must have the form github.com=1 (depth 1–5).");
    }
    depths.set(domainName(match[1]), Number(match[2]));
  }
  return { excluded, depths };
}

export function autoGroupKey(spec, rules, effectiveTLD) {
  let uri;
  let domain;
  try {
    uri = new URL(spec);
    if (uri.protocol !== "https:" && uri.protocol !== "http:") {
      return null;
    }
    // IPs, localhost and public suffixes have no registrable site and are skipped.
    domain = effectiveTLD.getBaseDomainFromHost(uri.hostname.replace(/\.$/, ""));
  } catch {
    return null;
  }
  const host = uri.hostname.toLowerCase().replace(/\.$/, "");
  if (rules.excluded.has(domain) || rules.excluded.has(host)) {
    return null;
  }
  const depth = rules.depths.get(host) ?? rules.depths.get(domain) ?? 0;
  const segments = uri.pathname.split("/").filter(Boolean).slice(0, depth);
  const key = domain + (segments.length ? `/${segments.join("/")}` : "");
  let hash = 0;
  for (const character of domain) {
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  }
  return { key, domain, color: COLORS[(hash >>> 0) % COLORS.length] };
}
