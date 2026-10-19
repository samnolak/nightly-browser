/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export class ZenGalleryScrollChild extends JSWindowActorChild {
  receiveMessage({ name, data }) {
    if (name !== "Gallery:RestoreScroll") {
      return false;
    }
    const document = this.document;
    if (
      document.documentURI !== data.url ||
      !/^https?:\/\//.test(document.documentURI) ||
      this.browsingContext.parent ||
      !Number.isFinite(data.x) ||
      !Number.isFinite(data.y)
    ) {
      return false;
    }
    // No selector evaluation, script injection, or cross-origin redirects.
    this.contentWindow.scrollTo({
      left: Math.max(0, Math.min(data.x, 10000000)),
      top: Math.max(0, Math.min(data.y, 10000000)),
      behavior: "instant",
    });
    return true;
  }
}
