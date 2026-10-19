/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_ZenEmbedHost_h__
#define mozilla_ZenEmbedHost_h__

class nsCocoaWindow;
class nsIURI;
class nsIWidget;

namespace mozilla::layers {
class NativeLayerRootCA;
}

namespace zen {

// Lets an external app (Ombra) show Nightly windows inside its own window.
//
// The embedder registers a Mach bootstrap service and starts Nightly with
// NIGHTLY_EMBED_SERVICE=<service name> and
// -chrome chrome://browser/content/zen-embed.xhtml?pane=<token>. Only windows
// of that chrome-less document (one per embedder pane) are embedded: they
// never go on screen, every frame they present is sent to the embedder as an
// IOSurface, and the embedder's mouse, wheel and keyboard input is replayed
// into them (trusted, with native key bindings). Other windows of the process
// (the hidden window, anything a page opens) stay ordinary windows. Without
// the variable nothing here runs. Protocol and authentication are described
// in ZenEmbedHost.mm.
class ZenEmbedHost final {
 public:
  // Whether this process was started by an embedder. Main thread.
  static bool IsEnabled();

  // Whether the top-level window being created now is an embed window (see
  // AutoEmbedScope). Main thread.
  static bool ShouldEmbedNewWindow();

  // chrome://browser/content/zen-embed.xhtml: the document of every embed
  // window. A page's new window is opened with it in an embedder's runtime
  // (AppWindow::CreateNewContentWindow), so the embedder can show it.
  static const char* EmbedDocument();

  // Whether aWidget is an embed window of that document (not a browser window
  // OpenBrowserWindow opened, not an ordinary window): a page's new window
  // opens as one only from such a window. Main thread.
  static bool IsEmbedDocumentWindow(nsIWidget* aWidget);

  // Marks the windows created while it lives as embedded when aUrl is the
  // embed document (nsWindowWatcher::OpenWindowInternal and
  // AppWindow::CreateNewContentWindow, around the window's creation).
  class AutoEmbedScope final {
   public:
    explicit AutoEmbedScope(nsIURI* aUrl);
    ~AutoEmbedScope();

   private:
    bool mPrevious;
  };

  // Lifetime of an embedded nsCocoaWindow. Main thread.
  static void WindowCreated(nsCocoaWindow* aWindow,
                            mozilla::layers::NativeLayerRootCA* aLayerRoot);
  static void WindowVisibilityChanged(nsCocoaWindow* aWindow, bool aVisible);
  static void WindowDestroyed(nsCocoaWindow* aWindow);
  // The pointer shape (nsCursor) the page wants over an embedded window: the
  // embedder shows it (nsCocoaWindow::SetCursor). Main thread.
  static void CursorChanged(nsCocoaWindow* aWindow, int aCursor);
};

}  // namespace zen

#endif  // mozilla_ZenEmbedHost_h__
