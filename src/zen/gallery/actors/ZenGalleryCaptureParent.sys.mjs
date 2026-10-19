/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ZenGalleryCapture } from "resource:///modules/ZenGalleryCapture.sys.mjs";

export class ZenGalleryCaptureParent extends JSWindowActorParent {
  receiveMessage(message) {
    // No child message can unlock storage, choose a path, export, or initiate a
    // screenshot. Region replies require a pending chrome-created capability.
    if (
      ![
        "Gallery:Region",
        "Gallery:Cancelled",
        "Gallery:Drag",
        "Gallery:DragEnd",
      ].includes(message.name)
    ) {
      return;
    }
    const browser = this.browsingContext.top.embedderElement;
    if (
      !browser ||
      this.browsingContext !== this.browsingContext.top ||
      this.manager !== this.browsingContext.currentWindowGlobal ||
      !/^https?:$/.test(this.manager.documentPrincipal.URI?.scheme + ":")
    ) {
      return;
    }
    ZenGalleryCapture.receive(this, browser, message);
  }

  didDestroy() {
    ZenGalleryCapture.actorDestroyed(this);
  }
}
