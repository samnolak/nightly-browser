/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export class AboutGallery {
  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);

  getURIFlags() {
    // Like about:downloads: parent-process chrome, never content-safe.
    return (
      Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI
    );
  }

  getChromeURI() {
    return Services.io.newURI("chrome://browser/content/gallery/gallery.html");
  }

  newChannel(uri, loadInfo) {
    if (uri.spec !== "about:gallery") {
      throw Components.Exception(
        "Invalid gallery URI",
        Cr.NS_ERROR_ILLEGAL_VALUE
      );
    }
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      this.getChromeURI(),
      loadInfo
    );
    channel.originalURI = uri;
    return channel;
  }
}
