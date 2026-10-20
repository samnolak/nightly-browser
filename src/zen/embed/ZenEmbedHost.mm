/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/ZenEmbedHost.h"

#include "InputData.h"
#include "mozilla/Atomics.h"
#include "mozilla/Components.h"
#include "mozilla/Logging.h"
#include "mozilla/Maybe.h"
#include "mozilla/MouseEvents.h"
#include "mozilla/Mutex.h"
#include "mozilla/Preferences.h"
#include "mozilla/Services.h"
#include "mozilla/StaticPrefs_general.h"
#include "mozilla/UniquePtr.h"
#include "mozilla/layers/NativeLayerCA.h"
#include "nsChildView.h"
#include "nsCocoaWindow.h"
#include "nsIAppStartup.h"
#include "nsIAppWindow.h"
#include "nsIDocShell.h"
#include "nsIObserver.h"
#include "nsIObserverService.h"
#include "nsIRollupListener.h"
#include "nsITimer.h"
#include "nsIURI.h"
#include "nsIWidgetListener.h"
#include "nsIWindowWatcher.h"
#include "nsLayoutUtils.h"
#include "nsPIDOMWindow.h"
#include "nsString.h"
#include "nsTArray.h"
#include "nsThreadUtils.h"
#include "nsXULAppAPI.h"

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <signal.h>

#import <AppKit/AppKit.h>
#include <IOSurface/IOSurface.h>
#include <Security/Security.h>
#include <dispatch/dispatch.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <servers/bootstrap.h>
#include <unistd.h>

// Wire protocol, version 4 (4 added the device command, quitting, dialogs and
// downloads). Plain Mach messages:
//  - Nightly -> embedder go to the embedder's bootstrap service port.
//  - Embedder -> Nightly go to a receive right that Nightly hands over in Hello.
// Handshake: Nightly sends Hello; the embedder answers HelloAck. Nightly checks
// the audit token of that answer (same user, plus a code-signing requirement
// from zen.embed.peer-requirement (Developer ID), else the code directory hash
// zen.embed.peer-cdhash that the embedder wrote into this profile (ad-hoc
// signed release), or zen.embed.allow-unsigned-peer=true for development)
// and only then exports frames or accepts input. Every later
// message must come from the same pid/pidversion. When that process exits,
// Nightly quits: the runtime lives only as long as its embedder.
// Windows: one per embedder pane. The first is opened by -chrome
// zen-embed.xhtml?pane=<token>, more by OpenWindow{token}. Window{id, pane,
// size, scale, opener} reports each (pane is 0 until the document has loaded).
// A window a page opens (window.open, target=_blank, "Open Link in New Tab")
// is an embed window too (AppWindow::CreateNewContentWindow): it has pane 0
// and names the window whose page opened it (opener); the embedder shows it
// as a tab of its own, or closes it.
// Frames: each new IOSurface of a window is sent once as a send right
// (Surface); every presented frame is announced as Frame{surfaceId, seq}.
// Nightly holds an IOSurface use count for each announced frame until the
// embedder answers Release{seq}, so the surface pool cannot recycle a buffer
// the embedder is still reading; at most kMaxFramesInFlight are outstanding,
// newer frames wait (only the latest is kept).
// Input coordinates are window content points with the origin at the top left.
// Control: Command{op, url} (navigate, reload, back, forward, stop, close) goes
// to the window's chrome script (zen-embed.js); it reports the top-level
// document as Location{flags, url, title}.
// Scripts (the embedder's agent tools): Script{requestId, kind, source, args}
// runs in the window's top-level document, through zen-embed.js and the
// ZenEmbedAgent actor in the content process: kind 1 in the page's own world
// (as WKWebView's evaluateJavaScript), kind 2 a function called in an isolated
// world of the embedder's (as a WKContentWorld). The answer is
// ScriptResult{requestId, status, text}. Both carry their text out of line
// (one OOL descriptor), so they are only as large as kMaxScript.
// Popups are the embedder's to draw: a <select> dropdown, the page's context
// menu and form autocomplete arrive as Popup{popupId, JSON items and anchor
// rect} from zen-embed.js (out of line too); the embedder answers
// PopupChoice{popupId, index} (-1: dismissed), and PopupClosed{popupId} tells
// it the page closed one itself.
// Text input from the embedder's input method: Text commits, MarkedText
// {selection, text} is the composition (setMarkedText:; empty text cancels
// it, and is nothing once Gecko has ended the composition itself), and
// TextRect{x, y, w, h} answers where the composition's selection is
// (window points) for the embedder's candidate window. Cursor{nsCursor}
// reports the pointer shape the page wants over the window.
// Protocol 4 adds: Quit{} asks Nightly to quit as a user would (sessions and
// profile written and closed) before the embedder ends what is left. The
// page's questions (ZenEmbedDialogs.sys.mjs: alert/confirm/prompt, sign-in,
// permissions, file pickers, downloads) arrive as Dialog{dialogId, JSON} (out
// of line) and are answered with DialogReply{dialogId, JSON} (out of line);
// DialogClosed{dialogId} withdraws one. Download{dialogId, JSON} reports the
// progress of a download whose path a Dialog chose (window 0 once its window
// is gone); DownloadCancel{dialogId} stops it.
// Browser windows (protocol 4, id 43): OpenBrowserWindow{token} opens a full
// browser window (browser.xhtml, the whole Zen UI) for the pane, embedded and
// exported as any embed window, with the pane known from the start (there is
// no zen-embed.js in it). Its chrome is Nightly's own: menus, panels, the URL
// bar's dropdown, doorhangers and tooltips are real popup windows on screen
// where the pane is (nsCocoaWindow::Show), above the embedder's window, never
// activating Nightly; they roll up when the embedder deactivates the window
// (Focus 0) or moves it (Resize with another origin). Keys reach its <key>s
// as in any browser window. Command{navigate} opens the URL in a new tab
// (ZenEmbedBrowser.sys.mjs); the other commands go to its selected tab. Any
// other browser window opened meanwhile (a page's popup, a new or restored
// window) is a stray: embedded, never on screen nor sent to the embedder, its
// tabs moved into the pane's window by ZenEmbedBrowser.sys.mjs. When the
// embedder's first pane is a browser window, Nightly starts with -chrome
// browser.xhtml and NIGHTLY_EMBED_BROWSER_PANE=<token> (AutoEmbedScope).
// Drags (protocol 4, ids 44-45 and 123-124). An embedded window is never on
// screen, so AppKit can neither run a drag from it nor send it one over it:
// the embedder's mouse does both. A drag that starts in the window
// (ZenEmbedHost::BeginDrag) is announced as DragStarted{image (PNG, out of
// line), its frame and the press, in window points; the drag pasteboard, a
// named one holding its data}; the Mouse messages that follow with the button
// held move it over the window (drag events for the page and the chrome),
// the release drops it, Escape cancels it. When the pointer leaves the pane
// the embedder may carry it on as its own AppKit drag of that data (it reads
// it from the pasteboard as the destination asks): DragSource{carried} says
// so, and DragSource{ended, operation, where} ends the drag later. An AppKit
// drag over the pane (from another app, or the embedder's carried one) comes
// as DragTarget{enter, over, exit, drop; point; the source's operations};
// its data is on the system's drag pasteboard. Each step is answered with
// DragStatus{operation}, what a drop there would do (NSDragOperation);
// DragStatus{ended} once the window's own drag is over.

using namespace mozilla;
using mozilla::layers::NativeLayerRootCA;
using mozilla::layers::NativeLayerRootCAObserver;

static LazyLogModule sEmbedLog("ZenEmbed");
#define EMBED_LOG(...) MOZ_LOG(sEmbedLog, LogLevel::Info, (__VA_ARGS__))

// widget/cocoa's drag state (nsCocoaWindow.mm): the pasteboard of the drag in
// progress and the mouse press that started it.
extern NSPasteboard* globalDragPboard;
extern NSEvent* gLastDragMouseDownEvent;

// The NSDraggingInfo of a drag over an embedded window (Channel's drags): the
// embedder's pointer where AppKit would have its own.
@interface ZenEmbedDragInfo : NSObject <ZenEmbedDraggingInfo>
- (instancetype)initWithWindow:(NSWindow*)aWindow
                    pasteboard:(NSPasteboard*)aPasteboard
                        source:(id)aSource
                    operations:(NSDragOperation)aOperations
                      sequence:(NSInteger)aSequence;
// The pointer is at aLocation (window coordinates), moved there by aEvent.
- (void)moveTo:(NSPoint)aLocation event:(NSEvent*)aEvent;
@end

@implementation ZenEmbedDragInfo {
  NSWindow* mWindow;          // [weak] The embedded window; outlives its drags.
  NSPasteboard* mPasteboard;  // [strong]
  id mSource;                 // [weak] The window's view, for its own drag.
  NSDragOperation mOperations;
  NSInteger mSequence;
  NSPoint mLocation;
  NSEvent* mEvent;  // [strong]
}

@synthesize draggingFormation;
@synthesize animatesToDestination;
@synthesize numberOfValidItemsForDrop;

- (instancetype)initWithWindow:(NSWindow*)aWindow
                    pasteboard:(NSPasteboard*)aPasteboard
                        source:(id)aSource
                    operations:(NSDragOperation)aOperations
                      sequence:(NSInteger)aSequence {
  if ((self = [super init])) {
    mWindow = aWindow;
    mPasteboard = [aPasteboard retain];
    mSource = aSource;
    mOperations = aOperations;
    mSequence = aSequence;
  }
  return self;
}

- (void)dealloc {
  [mPasteboard release];
  [mEvent release];
  [super dealloc];
}

- (void)moveTo:(NSPoint)aLocation event:(NSEvent*)aEvent {
  mLocation = aLocation;
  // aEvent may be mEvent itself (the dragover a resting pointer repeats).
  [aEvent retain];
  [mEvent release];
  mEvent = aEvent;
}

- (NSEvent*)zenEmbedEvent {
  return mEvent;
}

- (NSWindow*)draggingDestinationWindow {
  return mWindow;
}

- (NSDragOperation)draggingSourceOperationMask {
  return mOperations;
}

- (NSPoint)draggingLocation {
  return mLocation;
}

- (NSPoint)draggedImageLocation {
  return mLocation;
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-implementations"
- (NSImage*)draggedImage {
  return nil;
}

- (NSArray<NSString*>*)namesOfPromisedFilesDroppedAtDestination:
    (NSURL*)aDestination {
  return nil;
}
#pragma clang diagnostic pop

- (NSPasteboard*)draggingPasteboard {
  return mPasteboard;
}

- (id)draggingSource {
  return mSource;
}

- (NSInteger)draggingSequenceNumber {
  return mSequence;
}

- (void)slideDraggedImageTo:(NSPoint)aScreenPoint {
}

// No dragging items to move: the embedder draws the drag image.
- (void)enumerateDraggingItemsWithOptions:
            (NSDraggingItemEnumerationOptions)aOptions
                                  forView:(NSView*)aView
                                  classes:(NSArray<Class>*)aClasses
                            searchOptions:
                                (NSDictionary<NSPasteboardReadingOptionKey, id>*)
                                    aSearchOptions
                               usingBlock:(void (^)(NSDraggingItem*, NSInteger,
                                                    BOOL*))aBlock {
}

- (NSSpringLoadingHighlight)springLoadingHighlight {
  return NSSpringLoadingHighlightNone;
}

- (void)resetSpringLoading {
}
@end

namespace zen {
namespace {

constexpr uint32_t kProtocolVersion = 4;
constexpr size_t kMaxFramesInFlight = 3;
constexpr size_t kMaxSentSurfaces = 16;
// URL and title bytes in Command and Location.
constexpr uint32_t kMaxText = 8192;
// Dialog replies include securely archived native printer settings (PPDs).
constexpr uint32_t kMaxDialogReply = 1u << 20;
// Script source plus arguments, and script results, in bytes.
constexpr uint32_t kMaxScript = 64u << 20;
// kVK_Escape: cancels a drag.
constexpr uint16_t kEscapeKeyCode = 0x35;
// While the pointer rests over the window, a drag's dragover repeats this
// often (AppKit's periodic draggingUpdated:).
constexpr uint32_t kDragRepeatMs = 100;
constexpr char kEmbedDocument[] = "chrome://browser/content/zen-embed.xhtml";
constexpr char kBrowserDocument[] = "chrome://browser/content/browser.xhtml";

enum : mach_msg_id_t {
  kMsgSurface = 1,
  kMsgFrame = 2,
  kMsgRelease = 3,
  kMsgMouse = 20,
  kMsgKey = 21,
  kMsgFocus = 22,
  kMsgResize = 23,
  kMsgWheel = 24,
  kMsgText = 25,
  kMsgCommand = 26,
  kMsgOpenWindow = 27,
  kMsgScript = 28,
  kMsgPopupChoice = 29,
  kMsgMarkedText = 30,
  // Protocol 4 (K1 cutover): 40-49 embedder -> Nightly, 120-129 back.
  kMsgQuit = 40,
  kMsgDialogReply = 41,
  kMsgDownloadCancel = 42,
  kMsgOpenBrowserWindow = 43,
  // Drags (see the comment at the top): 44-45 embedder -> Nightly, 123-124
  // back.
  kMsgDragTarget = 44,
  kMsgDragSource = 45,
  kMsgHello = 100,
  kMsgHelloAck = 101,
  kMsgWindow = 102,
  kMsgLocation = 103,
  kMsgScriptResult = 104,
  kMsgPopup = 105,
  kMsgPopupClosed = 106,
  kMsgCursor = 107,
  kMsgTextRect = 108,
  kMsgDialog = 120,
  kMsgDialogClosed = 121,
  kMsgDownload = 122,
  kMsgDragStarted = 123,
  kMsgDragStatus = 124,
};

enum : int32_t { kMouseDown = 1, kMouseUp = 2, kMouseMove = 3, kMouseExit = 4 };

// Command ops, as zen-embed.js reads them.
enum : uint32_t {
  kCommandNavigate = 1,
  kCommandReload = 2,
  kCommandBack = 3,
  kCommandForward = 4,
  kCommandStop = 5,
  kCommandClose = 6,
  // Protocol 4: the emulated device, JSON (zen-embed.js ZenEmbedDevice); ""
  // ends the device mode.
  kCommandDevice = 7,
  // Protocol 4: the embedder's appearance, "dark" or "light" ("" follows
  // macOS), for the whole runtime (any window id, 0 too): it sets
  // ui.systemUsesDarkTheme, which Zen's automatic scheme, the chrome and the
  // pages' prefers-color-scheme follow live.
  kCommandTheme = 8,
};

// Script kinds and result statuses, as zen-embed.js and the embedder read them.
enum : uint32_t { kScriptPage = 1, kScriptIsolated = 2 };
enum : uint32_t {
  kScriptValue = 0,      // text: the value (a string as it is, else JSON)
  kScriptUndefined = 1,  // no text: undefined, null, or nothing to send back
  kScriptError = 2,      // text: the exception, then its stack
  kScriptNoPage = 3,     // text: why there is no document to run in
};

struct HelloMsg {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t port;
  uint32_t version;
  int32_t pid;
};
static_assert(sizeof(HelloMsg) == 48);

struct HelloAckMsg {
  mach_msg_header_t header;
  uint32_t version;
  uint32_t reserved;
};
static_assert(sizeof(HelloAckMsg) == 32);

struct WindowMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  uint32_t visible;
  double width;
  double height;
  double scale;
  uint32_t pane;    // 0 until the embed document has loaded.
  uint32_t opener;  // The window whose page opened this one; 0 for none.
};
static_assert(sizeof(WindowMsg) == 64);

// index: the chosen item, -1 when the popup was dismissed.
struct PopupChoiceMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  uint32_t popupId;
  int32_t index;
  uint32_t reserved;
};
static_assert(sizeof(PopupChoiceMsg) == 40);

struct PopupClosedMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  uint32_t popupId;
};
static_assert(sizeof(PopupClosedMsg) == 32);

// Quit (reserved: 0).
struct QuitMsg {
  mach_msg_header_t header;
  uint32_t reserved[2];
};
static_assert(sizeof(QuitMsg) == 32);

// DialogClosed and DownloadCancel.
struct DialogIdMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  uint32_t dialogId;
};
static_assert(sizeof(DialogIdMsg) == 32);

// The composition: count UTF-16 units of text with the selection (caret) at
// selStart for selLength units; count 0 ends it with nothing.
struct MarkedTextMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  int32_t selStart;
  int32_t selLength;
  int32_t count;
  uint16_t chars[64];
};
static_assert(sizeof(MarkedTextMsg) == 168);

// cursor: nsCursor (eCursor_standard = 0, eCursor_select = 2 …).
struct CursorMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  uint32_t cursor;
};
static_assert(sizeof(CursorMsg) == 32);

// Window content points, origin at the top left.
struct TextRectMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  uint32_t reserved;
  double x;
  double y;
  double width;
  double height;
};
static_assert(sizeof(TextRectMsg) == 64);

struct SurfaceMsg {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t surface;
  uint32_t windowId;
  uint32_t surfaceId;
  uint32_t width;
  uint32_t height;
};
static_assert(sizeof(SurfaceMsg) == 56);

struct FrameMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  uint32_t surfaceId;
  uint64_t seq;
  uint64_t presentedAt;  // mach_absolute_time()
  uint32_t width;
  uint32_t height;
  uint32_t flipped;
  uint32_t reserved;
};
static_assert(sizeof(FrameMsg) == 64);

struct ReleaseMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  uint32_t reserved;
  uint64_t seq;
};
static_assert(sizeof(ReleaseMsg) == 40);

// kind: kMouseDown/Up/Move/Exit. button: 0 left, 1 right, 2 middle, -1 none
// (a move without a pressed button). modifiers: NSEventModifierFlags.
struct MouseMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  int32_t kind;
  int32_t button;
  int32_t clickCount;
  double x;
  double y;
  uint64_t modifiers;
};
static_assert(sizeof(MouseMsg) == 64);

// down: 1 key down, 0 key up, 2 flagsChanged (a modifier alone; keyCode is the
// modifier key's, modifiers the flags after it). keyCode: macOS virtual key
// code. chars / unmodifiedChars: UTF-16, as in NSEvent characters /
// charactersIgnoringModifiers.
struct KeyMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  int32_t down;
  int32_t keyCode;
  int32_t charCount;
  uint64_t modifiers;
  uint16_t chars[16];
  uint16_t unmodifiedChars[16];
  int32_t unmodifiedCount;
  int32_t isRepeat;
};
static_assert(sizeof(KeyMsg) == 120);

struct FocusMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  uint32_t focused;
};
static_assert(sizeof(FocusMsg) == 32);

// Content size in points. With kResizeHasOrigin, (screenX, screenY) is where
// the pane's bottom-left corner is on screen (Cocoa coordinates): the window
// (never ordered in) moves there, so it takes that screen's backing scale.
enum : uint32_t { kResizeHasOrigin = 1 };
struct ResizeMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  uint32_t flags;
  double width;
  double height;
  double screenX;
  double screenY;
};
static_assert(sizeof(ResizeMsg) == 64);

// One NSEvent of type scrollWheel. phase / momentumPhase: NSEventPhase.
// delta: scrollingDeltaX/Y (points when precise, else lines); lineDelta:
// deltaX/Y. Position as in MouseMsg.
enum : uint32_t { kWheelPrecise = 1 };
struct WheelMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  uint32_t phase;
  uint32_t momentumPhase;
  uint32_t flags;
  double x;
  double y;
  double deltaX;
  double deltaY;
  double lineDeltaX;
  double lineDeltaY;
  uint64_t modifiers;
};
static_assert(sizeof(WheelMsg) == 96);

// Committed text that did not come with a key (input methods), UTF-16.
struct TextMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  int32_t count;
  uint16_t chars[64];
};
static_assert(sizeof(TextMsg) == 160);

// text: UTF-8, `length` bytes (the URL for kCommandNavigate).
struct CommandMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  uint32_t op;
  uint32_t length;
  uint32_t reserved;
  char text[kMaxText];
};
static_assert(offsetof(CommandMsg, text) == 40);

struct OpenWindowMsg {
  mach_msg_header_t header;
  uint32_t pane;
  uint32_t reserved;
};
static_assert(sizeof(OpenWindowMsg) == 32);

// text: the URL (urlLength bytes) then the title (titleLength bytes), UTF-8.
enum : uint32_t {
  kLocationLoading = 1,
  kLocationCanGoBack = 2,
  kLocationCanGoForward = 4,
};
struct LocationMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  uint32_t flags;
  uint32_t urlLength;
  uint32_t titleLength;
  char text[kMaxText];
};
static_assert(offsetof(LocationMsg, text) == 40);

// data: sourceLength bytes of UTF-8 source, then argsLength bytes of UTF-8 JSON
// (the arguments of a kScriptIsolated function; empty for kScriptPage).
struct ScriptMsg {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_ool_descriptor_t data;
  uint32_t windowId;
  uint32_t requestId;
  uint32_t kind;
  uint32_t sourceLength;
  uint32_t argsLength;
};
static_assert(offsetof(ScriptMsg, windowId) == 44);
static_assert(sizeof(ScriptMsg) == 64);

// data: `length` bytes of UTF-8 (see the kScript* statuses).
struct ScriptResultMsg {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_ool_descriptor_t data;
  uint32_t windowId;
  uint32_t requestId;
  uint32_t status;
  uint32_t length;
  uint32_t reserved;
};
static_assert(offsetof(ScriptResultMsg, windowId) == 44);
static_assert(sizeof(ScriptResultMsg) == 64);

// Drags. Points are window points with the origin at the top left (as in
// MouseMsg), operations NSDragOperation masks, modifiers NSEventModifierFlags.
enum : uint32_t { kDragEnter = 1, kDragOver = 2, kDragExit = 3, kDragDrop = 4 };
struct DragTargetMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  uint32_t phase;  // kDragEnter...kDragDrop
  double x;
  double y;
  uint64_t operations;  // What the drag's source allows.
  uint64_t modifiers;
};
static_assert(sizeof(DragTargetMsg) == 64);

// state: kDragCarried (the embedder's AppKit drag runs the window's drag
// now), kDragEnded (that drag ended with `operation` at x, y) or
// kDragCancelled (the user cancelled it, Escape).
enum : uint32_t { kDragCarried = 1, kDragEnded = 2, kDragCancelled = 3 };
struct DragSourceMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  uint32_t state;
  double x;
  double y;
  uint64_t operation;
  uint64_t modifiers;
};
static_assert(sizeof(DragSourceMsg) == 64);

// image: imageLength bytes of PNG at the window's backing scale, drawn at
// image{X, Y, Width, Height} when the pointer is at pointer{X, Y}.
// pasteboard: the named pasteboard with the drag's data (UTF-8).
struct DragStartedMsg {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_ool_descriptor_t image;
  uint32_t windowId;
  uint32_t imageLength;
  uint32_t pasteboardLength;
  double imageX;
  double imageY;
  double imageWidth;
  double imageHeight;
  double pointerX;
  double pointerY;
  uint64_t operations;
  char pasteboard[128];
};
static_assert(offsetof(DragStartedMsg, windowId) == 44);
static_assert(offsetof(DragStartedMsg, imageX) == 56);
static_assert(sizeof(DragStartedMsg) == 240);

enum : uint32_t { kDragStatusEnded = 1 };
struct DragStatusMsg {
  mach_msg_header_t header;
  uint32_t windowId;
  uint32_t flags;  // kDragStatusEnded: the window's own drag is over.
  uint64_t operation;
};
static_assert(sizeof(DragStatusMsg) == 40);

union ReceiveBuffer {
  mach_msg_header_t header;
  uint8_t bytes[sizeof(CommandMsg) + 512];
};

class Channel;
static Channel* sChannel = nullptr;  // Lives for the rest of the process.
static bool sEmbedNextWindow = false;
// The pane of the browser window OnOpenBrowserWindow is opening (0: none);
// AddWindow takes it.
static uint32_t sBrowserPaneForNextWindow = 0;
// The browser window being created is a stray (AutoEmbedScope): any other
// browser window while a pane's is open. AddWindow takes it.
static bool sStrayNextWindow = false;

class WindowExporter final : public NativeLayerRootCAObserver {
 public:
  explicit WindowExporter(uint32_t aWindowId)
      : mWindowId(aWindowId), mMutex("ZenEmbed::WindowExporter") {}

  // Compositor thread (or the render thread without a GPU process).
  void OnCommitToScreen(IOSurfaceRef aSurface, const gfx::IntSize& aSize,
                        bool aIsFlipped) override;

  void SetVisible(bool aVisible);
  // Sends the latest frame that could not be sent yet, if it can be now.
  void Flush();
  void ReleaseFrame(uint64_t aSeq);
  // Forgets everything the embedder had; it gets surfaces again on demand.
  void Reset();

 private:
  ~WindowExporter() override { Reset(); }

  struct Frame {
    CFTypeRefPtr<IOSurfaceRef> mSurface;
    gfx::IntSize mSize;
    bool mIsFlipped = false;
  };
  struct InFlight {
    uint64_t mSeq = 0;
    CFTypeRefPtr<IOSurfaceRef> mSurface;
  };

  bool CanSendLocked() const;
  void SendLocked(const Frame& aFrame);

  const uint32_t mWindowId;
  Mutex mMutex MOZ_UNANNOTATED;
  bool mVisible = false;
  uint32_t mLastSurfaceId = 0;
  uint64_t mNextSeq = 1;
  gfx::IntSize mLastSize;
  nsTArray<uint32_t> mSentSurfaces;
  nsTArray<InFlight> mInFlight;
  Maybe<Frame> mPending;
};

// The embed documents' notifications (zen-embed.js): zen-embed-ready (data:
// the pane token), zen-embed-location (data: "flags\nurl\ntitle") and
// zen-embed-script-result (data: "requestId\nstatus\ntext").
class ChromeObserver final : public nsIObserver {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIOBSERVER

 private:
  ~ChromeObserver() = default;
};

class Channel final {
 public:
  Channel() : mExportersMutex("ZenEmbed::Channel::mExporters") {}

  static Channel* GetOrCreate();

  bool Authenticated() const { return mAuthenticated; }

  // Any thread. Never blocks unless aTimeoutMs is set; a full embedder queue
  // drops the message.
  bool Send(mach_msg_header_t* aHeader, mach_msg_size_t aSize,
            mach_msg_timeout_t aTimeoutMs = 0);

  // Main thread.
  void AddWindow(nsCocoaWindow* aWindow, NativeLayerRootCA* aLayerRoot);
  void SetWindowVisible(nsCocoaWindow* aWindow, bool aVisible);
  void RemoveWindow(nsCocoaWindow* aWindow);
  // aOpener: the outer window id of the chrome window whose page opened this
  // one (0 for none).
  void OnChromeReady(nsPIDOMWindowOuter* aWindow, uint32_t aPane,
                     uint64_t aOpener);
  void OnChromeLocation(nsPIDOMWindowOuter* aWindow, const nsACString& aData);
  void OnChromeScriptResult(nsPIDOMWindowOuter* aWindow,
                            const nsACString& aData);
  void OnChromePopup(nsPIDOMWindowOuter* aWindow, const nsACString& aData);
  void OnChromePopupClosed(nsPIDOMWindowOuter* aWindow,
                           const nsACString& aData);
  // ZenEmbedDialogs: "id\njson" questions, "id" withdrawals, and downloads
  // ("id\njson"; aWindow null once the window is gone).
  void OnChromeDialog(nsPIDOMWindowOuter* aWindow, const nsACString& aData);
  void OnChromeDialogClosed(nsPIDOMWindowOuter* aWindow,
                            const nsACString& aData);
  void OnChromeDownload(nsPIDOMWindowOuter* aWindow, const nsACString& aData);
  void CursorChanged(nsCocoaWindow* aWindow, uint32_t aCursor);
  // Sends where the composition's selection is in the window, when it has one.
  void ReportTextRect(uint32_t aWindowId);
  // Whether aWidget is an embed window of the chrome-less document (not a
  // browser window, not an ordinary one).
  bool IsEmbedDocumentWindow(nsIWidget* aWidget);
  // Whether one of the embedder's panes shows a browser window.
  bool HasBrowserWindow() const;
  // A drag starts in aView (ZenEmbedHost::BeginDrag): false when aView is not
  // an embedded window's.
  bool BeginDrag(NSView* aView, NSArray<NSDraggingItem*>* aItems);

 private:
  struct Entry {
    uint32_t mId = 0;
    uint32_t mPane = 0;
    uint32_t mOpener = 0;  // Entry id of the window whose page opened it.
    bool mReady = false;   // zen-embed.js listens (zen-embed-ready).
    bool mBrowser = false;  // A browser window (OpenBrowserWindow).
    bool mAnnounced = false;  // zen-embed-browser-window sent (mBrowser).
    // Any other browser window opened while a pane's is open (a page's popup,
    // a new window, a restored one): embedded so that it never shows, never
    // sent to the embedder; ZenEmbedBrowser.sys.mjs moves its tabs into the
    // pane's window and closes it (zen-embed-stray-window).
    bool mStray = false;
    nsCocoaWindow* mWindow = nullptr;  // Removed in WindowDestroyed.
    RefPtr<NativeLayerRootCA> mLayerRoot;
    RefPtr<WindowExporter> mExporter;
    bool mVisible = false;
    uint32_t mCursor = 0;  // nsCursor last sent.
  };

  bool Connect(const char* aService);
  void DrainReceive();
  void HandleMessage(const ReceiveBuffer& aBuffer);
  void Authenticate(const audit_token_t& aToken);
  void WatchPeer(pid_t aPid);
  static bool PeerMatchesRequirement(const audit_token_t& aToken,
                                     const nsACString& aRequirement);
  static nsCString CdhashRequirement();
  Entry* FindEntry(uint32_t aWindowId);
  Entry* FindEntry(nsPIDOMWindowOuter* aWindow);
  RefPtr<WindowExporter> FindExporter(uint32_t aWindowId);
  void SendWindow(const Entry& aEntry);
  void OnMouse(const MouseMsg& aMsg);
  void OnKey(const KeyMsg& aMsg);
  void OnFocus(const FocusMsg& aMsg);
  void OnResize(const ResizeMsg& aMsg);
  void OnWheel(const WheelMsg& aMsg);
  void OnText(const TextMsg& aMsg);
  void OnMarkedText(const MarkedTextMsg& aMsg);
  void OnCommand(uint32_t aWindowId, uint32_t aOp, const nsACString& aText);
  void OnOpenWindow(uint32_t aPane);
  void OnOpenBrowserWindow(uint32_t aPane);
  void OnScript(uint32_t aWindowId, uint32_t aRequestId, uint32_t aKind,
                const nsACString& aSource, const nsACString& aArgs);
  void OnPopupChoice(const PopupChoiceMsg& aMsg);
  void OnDialogReply(uint32_t aWindowId, uint32_t aDialogId,
                     const nsACString& aJson);
  void OnDownloadCancel(uint32_t aWindowId, uint32_t aDialogId);
  // "id\njson" split; false when the id is not a number.
  static bool SplitId(const nsACString& aData, uint32_t* aId,
                      nsDependentCSubstring* aRest);
  // A message with one out-of-line text: windowId at 44, then aField1,
  // aField2 and the text's length (ScriptResult, Popup).
  void SendOutOfLine(mach_msg_id_t aId, uint32_t aWindowId, uint32_t aField1,
                     uint32_t aField2, const nsACString& aText);
  void SendScriptResult(uint32_t aWindowId, uint32_t aRequestId,
                        uint32_t aStatus, const nsACString& aText);

  // Drags (see the comment at the top).
  // The window's own drag: the embedder's mouse moves it (DragMouse), its
  // release drops it, Escape or the embedder's deactivation cancels it, and
  // once the embedder carries it as its own AppKit drag, DragSource ends it.
  struct Drag {
    ~Drag();
    uint32_t mWindowId = 0;
    nsCocoaWindow* mWidget = nullptr;  // Gone with the window (RemoveWindow).
    ChildView* mView = nil;            // [strong]
    ZenEmbedDragInfo* mInfo = nil;     // [strong]
    bool mOver = false;     // draggingEntered: sent, and no exit since.
    bool mCarried = false;  // The embedder's AppKit drag runs it now.
    NSDragOperation mOperation = NSDragOperationNone;  // The last answer.
    double mMovedAt = 0;    // systemUptime of the last move.
    nsCOMPtr<nsITimer> mTimer;  // Repeats dragover while the pointer rests.
  };
  void DragMouse(NSEvent* aEvent, NSPoint aLocation);
  void DragTick();
  void CancelDrag(NSEvent* aEvent);
  void EndDrag(NSPoint aLocation, NSDragOperation aOperation, NSEvent* aEvent);
  void OnDragTarget(const DragTargetMsg& aMsg);
  void OnDragSource(const DragSourceMsg& aMsg);
  void SendDragStarted(const Entry& aEntry, NSDraggingItem* aItem,
                       NSPoint aPointer, NSString* aPasteboard);
  void SendDragStatus(uint32_t aWindowId, NSDragOperation aOperation,
                      uint32_t aFlags);

  mach_port_t mPeer = MACH_PORT_NULL;
  mach_port_t mReceive = MACH_PORT_NULL;
  dispatch_queue_t mQueue = nullptr;
  dispatch_source_t mSource = nullptr;
  dispatch_source_t mPeerExit = nullptr;
  Atomic<bool> mAuthenticated{false};
  Atomic<int32_t> mPeerPid{0};
  Atomic<uint32_t> mPeerPidVersion{0};

  // Main thread only.
  nsTArray<Entry> mWindows;
  uint32_t mNextWindowId = 1;
  RefPtr<ChromeObserver> mObserver;
  UniquePtr<Drag> mDrag;
  // An AppKit drag over a pane (DragTarget): its window and NSDraggingInfo.
  uint32_t mTargetWindow = 0;
  ZenEmbedDragInfo* mTargetInfo = nil;  // [strong]
  NSDragOperation mTargetOperation = NSDragOperationNone;
  NSInteger mDragSequence = 0;
  // Where the embedder's pointer last was over a window (window coordinates).
  uint32_t mMouseWindow = 0;
  NSPoint mMouse = NSZeroPoint;

  // Read on the receive queue (Release), written on the main thread.
  Mutex mExportersMutex MOZ_UNANNOTATED;
  nsTArray<std::pair<uint32_t, RefPtr<WindowExporter>>> mExporters;
};

// The chrome window of an embedded widget (its AppWindow's docshell window).
static nsCOMPtr<nsPIDOMWindowOuter> OuterWindowOf(nsCocoaWindow* aWidget) {
  nsIWidgetListener* listener = aWidget->GetWidgetListener();
  nsCOMPtr<nsIAppWindow> appWindow =
      listener ? listener->GetAppWindow() : nullptr;
  if (!appWindow) {
    return nullptr;
  }
  nsCOMPtr<nsIDocShell> docShell;
  appWindow->GetDocShell(getter_AddRefs(docShell));
  return docShell ? docShell->GetWindow() : nullptr;
}

static nsCOMPtr<nsPIDOMWindowOuter> OuterWindowOf(nsISupports* aSubject) {
  nsCOMPtr<nsPIDOMWindowOuter> outer = do_QueryInterface(aSubject);
  if (!outer) {
    if (nsCOMPtr<nsPIDOMWindowInner> inner = do_QueryInterface(aSubject)) {
      outer = inner->GetOuterWindow();
    }
  }
  return outer;
}

static Modifiers GeckoModifiers(uint64_t aFlags) {
  Modifiers result = 0;
  if (aFlags & NSEventModifierFlagShift) {
    result |= MODIFIER_SHIFT;
  }
  if (aFlags & NSEventModifierFlagControl) {
    result |= MODIFIER_CONTROL;
  }
  if (aFlags & NSEventModifierFlagOption) {
    result |= MODIFIER_ALT | MODIFIER_ALTGRAPH;  // As nsCocoaUtils does.
  }
  if (aFlags & NSEventModifierFlagCommand) {
    result |= MODIFIER_META;
  }
  if (aFlags & NSEventModifierFlagCapsLock) {
    result |= MODIFIER_CAPSLOCK;
  }
  return result;
}

// Closes the open menus and panels (whatever the rollup listener holds), as
// nsCocoaWindow does when a window goes away or the app is deactivated.
static void RollUpPopups() {
  nsIRollupListener* listener = nsIWidget::GetActiveRollupListener();
  if (!listener || !listener->GetRollupWidget()) {
    return;
  }
  nsIRollupListener::RollupOptions options{0, nullptr,
                                           nsIRollupListener::AllowAnimations::No};
  listener->Rollup(options);
}

// The embedder is gone: so is its runtime.
static void QuitForEmbedder() {
  if (nsCOMPtr<nsIAppStartup> startup = components::AppStartup::Service()) {
    startup->Quit(nsIAppStartup::eForceQuit, 0);
  }
}

// Posts aFn to the main thread inside an autorelease pool.
template <typename F>
static void OnMain(const char* aName, F&& aFn) {
  NS_DispatchToMainThread(NS_NewRunnableFunction(
      aName, [fn = std::forward<F>(aFn)]() mutable {
        @autoreleasepool {
          fn();
        }
      }));
}

// --- WindowExporter ---------------------------------------------------------

void WindowExporter::OnCommitToScreen(IOSurfaceRef aSurface,
                                      const gfx::IntSize& aSize,
                                      bool aIsFlipped) {
  MutexAutoLock lock(mMutex);
  if (IOSurfaceGetID(aSurface) == mLastSurfaceId) {
    return;  // Same frame committed again.
  }
  Frame frame{CFTypeRefPtr<IOSurfaceRef>::WrapUnderGetRule(aSurface), aSize,
              aIsFlipped};
  if (!CanSendLocked()) {
    mPending = Some(std::move(frame));
    return;
  }
  SendLocked(frame);
}

bool WindowExporter::CanSendLocked() const {
  return mVisible && sChannel && sChannel->Authenticated() &&
         mInFlight.Length() < kMaxFramesInFlight;
}

void WindowExporter::SendLocked(const Frame& aFrame) {
  IOSurfaceRef surface = aFrame.mSurface.get();
  uint32_t surfaceId = IOSurfaceGetID(surface);
  if (aFrame.mSize != mLastSize) {
    // New size: the embedder drops imports of other sizes.
    mSentSurfaces.Clear();
    mLastSize = aFrame.mSize;
  }
  if (!mSentSurfaces.Contains(surfaceId)) {
    SurfaceMsg msg{};
    msg.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0,
                                              MACH_MSGH_BITS_COMPLEX);
    msg.header.msgh_id = kMsgSurface;
    msg.body.msgh_descriptor_count = 1;
    msg.surface.name = IOSurfaceCreateMachPort(surface);
    msg.surface.disposition = MACH_MSG_TYPE_MOVE_SEND;
    msg.surface.type = MACH_MSG_PORT_DESCRIPTOR;
    msg.windowId = mWindowId;
    msg.surfaceId = surfaceId;
    msg.width = uint32_t(IOSurfaceGetWidth(surface));
    msg.height = uint32_t(IOSurfaceGetHeight(surface));
    if (!sChannel->Send(&msg.header, sizeof(msg))) {
      mPending = Some(aFrame);
      return;
    }
    if (mSentSurfaces.Length() >= kMaxSentSurfaces) {
      mSentSurfaces.RemoveElementAt(0);
    }
    mSentSurfaces.AppendElement(surfaceId);
  }

  FrameMsg msg{};
  msg.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, 0);
  msg.header.msgh_id = kMsgFrame;
  msg.windowId = mWindowId;
  msg.surfaceId = surfaceId;
  msg.seq = mNextSeq++;
  msg.presentedAt = mach_absolute_time();
  msg.width = uint32_t(IOSurfaceGetWidth(surface));
  msg.height = uint32_t(IOSurfaceGetHeight(surface));
  msg.flipped = aFrame.mIsFlipped ? 1 : 0;
  IOSurfaceIncrementUseCount(surface);
  if (!sChannel->Send(&msg.header, sizeof(msg))) {
    IOSurfaceDecrementUseCount(surface);
    mPending = Some(aFrame);
    return;
  }
  mInFlight.AppendElement(InFlight{msg.seq, aFrame.mSurface});
  mLastSurfaceId = surfaceId;
}

void WindowExporter::SetVisible(bool aVisible) {
  {
    MutexAutoLock lock(mMutex);
    mVisible = aVisible;
  }
  Flush();
}

void WindowExporter::Flush() {
  MutexAutoLock lock(mMutex);
  if (mPending && CanSendLocked()) {
    Frame frame = mPending.extract();
    if (IOSurfaceGetID(frame.mSurface.get()) != mLastSurfaceId) {
      SendLocked(frame);
    }
  }
}

void WindowExporter::ReleaseFrame(uint64_t aSeq) {
  {
    MutexAutoLock lock(mMutex);
    for (size_t i = 0; i < mInFlight.Length(); i++) {
      if (mInFlight[i].mSeq == aSeq) {
        IOSurfaceDecrementUseCount(mInFlight[i].mSurface.get());
        mInFlight.RemoveElementAt(i);
        break;
      }
    }
  }
  Flush();
}

void WindowExporter::Reset() {
  MutexAutoLock lock(mMutex);
  for (auto& frame : mInFlight) {
    IOSurfaceDecrementUseCount(frame.mSurface.get());
  }
  mInFlight.Clear();
  mSentSurfaces.Clear();
  mLastSurfaceId = 0;
  mLastSize = gfx::IntSize();
}

// --- ChromeObserver ---------------------------------------------------------

NS_IMPL_ISUPPORTS(ChromeObserver, nsIObserver)

NS_IMETHODIMP
ChromeObserver::Observe(nsISupports* aSubject, const char* aTopic,
                        const char16_t* aData) {
  if (!sChannel || !aData) {
    return NS_OK;
  }
  nsCOMPtr<nsPIDOMWindowOuter> window = OuterWindowOf(aSubject);
  NS_ConvertUTF16toUTF8 data(aData);
  if (!strcmp(aTopic, "zen-embed-download")) {
    // Downloads outlive their window: reported with window 0 then.
    sChannel->OnChromeDownload(window, data);
    return NS_OK;
  }
  if (!window) {
    return NS_OK;
  }
  if (!strcmp(aTopic, "zen-embed-ready")) {
    // "pane" or "pane\nopener" (the opener's outer window id).
    int32_t newline = data.FindChar('\n');
    nsresult rv, openerRv = NS_OK;
    uint32_t pane =
        nsAutoCString(Substring(data, 0, newline < 0 ? data.Length() : newline))
            .ToUnsignedInteger(&rv);
    uint64_t opener =
        newline < 0 ? 0
                    : nsAutoCString(Substring(data, newline + 1))
                          .ToUnsignedInteger64(&openerRv);
    if (NS_SUCCEEDED(rv) && NS_SUCCEEDED(openerRv)) {
      sChannel->OnChromeReady(window, pane, opener);
    }
  } else if (!strcmp(aTopic, "zen-embed-location")) {
    sChannel->OnChromeLocation(window, data);
  } else if (!strcmp(aTopic, "zen-embed-script-result")) {
    sChannel->OnChromeScriptResult(window, data);
  } else if (!strcmp(aTopic, "zen-embed-popup")) {
    sChannel->OnChromePopup(window, data);
  } else if (!strcmp(aTopic, "zen-embed-popup-closed")) {
    sChannel->OnChromePopupClosed(window, data);
  } else if (!strcmp(aTopic, "zen-embed-dialog")) {
    sChannel->OnChromeDialog(window, data);
  } else if (!strcmp(aTopic, "zen-embed-dialog-closed")) {
    sChannel->OnChromeDialogClosed(window, data);
  }
  return NS_OK;
}

// --- Channel ----------------------------------------------------------------

Channel* Channel::GetOrCreate() {
  MOZ_ASSERT(NS_IsMainThread());
  static bool sTried = false;
  if (sTried) {
    return sChannel;
  }
  sTried = true;
  const char* service = getenv("NIGHTLY_EMBED_SERVICE");
  auto* channel = new Channel();
  if (!channel->Connect(service)) {
    delete channel;
    // Started for an embedder that is not there (any more): its windows could
    // never be shown, so the process would only linger.
    OnMain("ZenEmbed::NoEmbedder", [] { QuitForEmbedder(); });
    return nullptr;
  }
  sChannel = channel;
  if (nsCOMPtr<nsIObserverService> obs = services::GetObserverService()) {
    channel->mObserver = new ChromeObserver();
    obs->AddObserver(channel->mObserver, "zen-embed-ready", false);
    obs->AddObserver(channel->mObserver, "zen-embed-location", false);
    obs->AddObserver(channel->mObserver, "zen-embed-script-result", false);
    obs->AddObserver(channel->mObserver, "zen-embed-popup", false);
    obs->AddObserver(channel->mObserver, "zen-embed-popup-closed", false);
    obs->AddObserver(channel->mObserver, "zen-embed-dialog", false);
    obs->AddObserver(channel->mObserver, "zen-embed-dialog-closed", false);
    obs->AddObserver(channel->mObserver, "zen-embed-download", false);
  }
  return sChannel;
}

bool Channel::Connect(const char* aService) {
  kern_return_t kr = bootstrap_look_up(bootstrap_port, aService, &mPeer);
  if (kr != KERN_SUCCESS) {
    EMBED_LOG("bootstrap_look_up(%s) failed: %d", aService, kr);
    return false;
  }
  kr = mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE,
                          &mReceive);
  if (kr != KERN_SUCCESS) {
    EMBED_LOG("mach_port_allocate failed: %d", kr);
    return false;
  }
  // Pointer moves can arrive in bursts.
  mach_port_limits_t limits = {MACH_PORT_QLIMIT_LARGE};
  mach_port_set_attributes(mach_task_self(), mReceive, MACH_PORT_LIMITS_INFO,
                           reinterpret_cast<mach_port_info_t>(&limits),
                           MACH_PORT_LIMITS_INFO_COUNT);

  mQueue = dispatch_queue_create("org.nightly.embed", DISPATCH_QUEUE_SERIAL);
  mSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_MACH_RECV, mReceive, 0,
                                   mQueue);
  dispatch_source_set_event_handler(mSource, ^{
    DrainReceive();
  });
  dispatch_resume(mSource);

  HelloMsg hello{};
  hello.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0,
                                              MACH_MSGH_BITS_COMPLEX);
  hello.header.msgh_remote_port = mPeer;
  hello.header.msgh_size = sizeof(hello);
  hello.header.msgh_id = kMsgHello;
  hello.body.msgh_descriptor_count = 1;
  hello.port.name = mReceive;
  hello.port.disposition = MACH_MSG_TYPE_MAKE_SEND;
  hello.port.type = MACH_MSG_PORT_DESCRIPTOR;
  hello.version = kProtocolVersion;
  hello.pid = getpid();
  kr = mach_msg(&hello.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
                sizeof(hello), 0, MACH_PORT_NULL, 1000, MACH_PORT_NULL);
  if (kr != KERN_SUCCESS) {
    EMBED_LOG("hello failed: %d", kr);
    return false;
  }
  EMBED_LOG("hello sent to %s", aService);
  return true;
}

bool Channel::Send(mach_msg_header_t* aHeader, mach_msg_size_t aSize,
                   mach_msg_timeout_t aTimeoutMs) {
  aHeader->msgh_remote_port = mPeer;
  aHeader->msgh_local_port = MACH_PORT_NULL;
  aHeader->msgh_size = aSize;
  kern_return_t kr =
      mach_msg(aHeader, MACH_SEND_MSG | MACH_SEND_TIMEOUT, aSize, 0,
               MACH_PORT_NULL, aTimeoutMs, MACH_PORT_NULL);
  if (kr == KERN_SUCCESS) {
    return true;
  }
  // Nothing was sent: release the rights the message carried.
  mach_msg_destroy(aHeader);
  if (kr == MACH_SEND_INVALID_DEST) {
    EMBED_LOG("embedder is gone");
    mAuthenticated = false;
  }
  return false;
}

void Channel::DrainReceive() {
  for (;;) {
    ReceiveBuffer buffer;
    kern_return_t kr = mach_msg(
        &buffer.header,
        MACH_RCV_MSG | MACH_RCV_TIMEOUT |
            MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
            MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
        0, sizeof(buffer) - sizeof(mach_msg_audit_trailer_t), mReceive, 0,
        MACH_PORT_NULL);
    if (kr == MACH_RCV_TIMED_OUT) {
      return;
    }
    if (kr == MACH_RCV_TOO_LARGE) {
      continue;  // Dequeued and destroyed by the kernel.
    }
    if (kr != KERN_SUCCESS) {
      EMBED_LOG("receive failed: %d", kr);
      return;
    }
    HandleMessage(buffer);
    if (buffer.header.msgh_bits & MACH_MSGH_BITS_COMPLEX) {
      mach_msg_destroy(&buffer.header);  // The embedder sends no rights.
    }
  }
}

void Channel::HandleMessage(const ReceiveBuffer& aBuffer) {
  const mach_msg_header_t& header = aBuffer.header;
  const auto* trailer = reinterpret_cast<const mach_msg_audit_trailer_t*>(
      aBuffer.bytes + round_msg(header.msgh_size));
  const audit_token_t token = trailer->msgh_audit;
  const mach_msg_size_t size = header.msgh_size;

  if (header.msgh_id == kMsgHelloAck) {
    if (size >= sizeof(HelloAckMsg)) {
      OnMain("ZenEmbed::Authenticate", [this, token] { Authenticate(token); });
    }
    return;
  }
  // audit_token_t: val[5] is the pid, val[7] the pid version.
  if (!mAuthenticated || int32_t(token.val[5]) != mPeerPid ||
      token.val[7] != mPeerPidVersion) {
    EMBED_LOG("dropping message %d from pid %u", header.msgh_id, token.val[5]);
    return;
  }

  switch (header.msgh_id) {
    case kMsgRelease:
      if (size >= sizeof(ReleaseMsg)) {
        const auto& msg = reinterpret_cast<const ReleaseMsg&>(aBuffer);
        if (RefPtr<WindowExporter> exporter = FindExporter(msg.windowId)) {
          exporter->ReleaseFrame(msg.seq);
        }
      }
      break;
    case kMsgMouse:
      if (size >= sizeof(MouseMsg)) {
        MouseMsg msg = reinterpret_cast<const MouseMsg&>(aBuffer);
        OnMain("ZenEmbed::Mouse", [this, msg] { OnMouse(msg); });
      }
      break;
    case kMsgKey:
      if (size >= sizeof(KeyMsg)) {
        KeyMsg msg = reinterpret_cast<const KeyMsg&>(aBuffer);
        OnMain("ZenEmbed::Key", [this, msg] { OnKey(msg); });
      }
      break;
    case kMsgFocus:
      if (size >= sizeof(FocusMsg)) {
        FocusMsg msg = reinterpret_cast<const FocusMsg&>(aBuffer);
        OnMain("ZenEmbed::Focus", [this, msg] { OnFocus(msg); });
      }
      break;
    case kMsgResize:
      if (size >= sizeof(ResizeMsg)) {
        ResizeMsg msg = reinterpret_cast<const ResizeMsg&>(aBuffer);
        OnMain("ZenEmbed::Resize", [this, msg] { OnResize(msg); });
      }
      break;
    case kMsgWheel:
      if (size >= sizeof(WheelMsg)) {
        WheelMsg msg = reinterpret_cast<const WheelMsg&>(aBuffer);
        OnMain("ZenEmbed::Wheel", [this, msg] { OnWheel(msg); });
      }
      break;
    case kMsgMarkedText:
      if (size >= sizeof(MarkedTextMsg)) {
        MarkedTextMsg msg = reinterpret_cast<const MarkedTextMsg&>(aBuffer);
        OnMain("ZenEmbed::MarkedText", [this, msg] { OnMarkedText(msg); });
      }
      break;
    case kMsgText:
      if (size >= sizeof(TextMsg)) {
        TextMsg msg = reinterpret_cast<const TextMsg&>(aBuffer);
        OnMain("ZenEmbed::Text", [this, msg] { OnText(msg); });
      }
      break;
    case kMsgCommand:
      if (size >= offsetof(CommandMsg, text)) {
        const auto& msg = reinterpret_cast<const CommandMsg&>(aBuffer);
        if (msg.length > kMaxText ||
            offsetof(CommandMsg, text) + msg.length > size) {
          break;
        }
        uint32_t windowId = msg.windowId;
        uint32_t op = msg.op;
        nsCString text(msg.text, msg.length);
        OnMain("ZenEmbed::Command", [this, windowId, op, text] {
          OnCommand(windowId, op, text);
        });
      }
      break;
    case kMsgPopupChoice:
      if (size >= sizeof(PopupChoiceMsg)) {
        PopupChoiceMsg msg = reinterpret_cast<const PopupChoiceMsg&>(aBuffer);
        OnMain("ZenEmbed::PopupChoice", [this, msg] { OnPopupChoice(msg); });
      }
      break;
    case kMsgQuit:
      if (size >= sizeof(QuitMsg)) {
        EMBED_LOG("embedder asked to quit");
        OnMain("ZenEmbed::Quit", [] { QuitForEmbedder(); });
      }
      break;
    case kMsgDownloadCancel:
      if (size >= sizeof(DialogIdMsg)) {
        DialogIdMsg msg = reinterpret_cast<const DialogIdMsg&>(aBuffer);
        OnMain("ZenEmbed::DownloadCancel", [this, msg] {
          OnDownloadCancel(msg.windowId, msg.dialogId);
        });
      }
      break;
    case kMsgDialogReply: {
      // Laid out as ScriptResult: the JSON is out of line, copied here.
      if (!(header.msgh_bits & MACH_MSGH_BITS_COMPLEX) ||
          size < sizeof(ScriptResultMsg)) {
        break;
      }
      const auto& msg = reinterpret_cast<const ScriptResultMsg&>(aBuffer);
      if (msg.body.msgh_descriptor_count != 1 ||
          msg.data.type != MACH_MSG_OOL_DESCRIPTOR || msg.length > kMaxDialogReply ||
          msg.length > msg.data.size || (msg.length > 0 && !msg.data.address)) {
        break;
      }
      nsCString json(static_cast<const char*>(msg.data.address), msg.length);
      uint32_t windowId = msg.windowId;
      uint32_t dialogId = msg.requestId;
      OnMain("ZenEmbed::DialogReply",
             [this, windowId, dialogId, json = std::move(json)] {
               OnDialogReply(windowId, dialogId, json);
             });
      break;
    }
    case kMsgOpenWindow:
      if (size >= sizeof(OpenWindowMsg)) {
        uint32_t pane = reinterpret_cast<const OpenWindowMsg&>(aBuffer).pane;
        OnMain("ZenEmbed::OpenWindow", [this, pane] { OnOpenWindow(pane); });
      }
      break;
    case kMsgOpenBrowserWindow:
      if (size >= sizeof(OpenWindowMsg)) {
        uint32_t pane = reinterpret_cast<const OpenWindowMsg&>(aBuffer).pane;
        OnMain("ZenEmbed::OpenBrowserWindow",
               [this, pane] { OnOpenBrowserWindow(pane); });
      }
      break;
    case kMsgScript: {
      // The text is out of line: copied here, before DrainReceive destroys
      // the message (and with it the mapping).
      if (!(header.msgh_bits & MACH_MSGH_BITS_COMPLEX) ||
          size < sizeof(ScriptMsg)) {
        break;
      }
      const auto& msg = reinterpret_cast<const ScriptMsg&>(aBuffer);
      uint64_t total = uint64_t(msg.sourceLength) + msg.argsLength;
      if (msg.body.msgh_descriptor_count != 1 ||
          msg.data.type != MACH_MSG_OOL_DESCRIPTOR || total > kMaxScript ||
          total > msg.data.size || (total > 0 && !msg.data.address)) {
        break;
      }
      const char* bytes = static_cast<const char*>(msg.data.address);
      nsCString source(bytes, msg.sourceLength);
      nsCString args(bytes + msg.sourceLength, msg.argsLength);
      uint32_t windowId = msg.windowId;
      uint32_t requestId = msg.requestId;
      uint32_t kind = msg.kind;
      OnMain("ZenEmbed::Script", [this, windowId, requestId, kind,
                                  source = std::move(source),
                                  args = std::move(args)] {
        OnScript(windowId, requestId, kind, source, args);
      });
      break;
    }
    case kMsgDragTarget:
      if (size >= sizeof(DragTargetMsg)) {
        DragTargetMsg msg = reinterpret_cast<const DragTargetMsg&>(aBuffer);
        OnMain("ZenEmbed::DragTarget", [this, msg] { OnDragTarget(msg); });
      }
      break;
    case kMsgDragSource:
      if (size >= sizeof(DragSourceMsg)) {
        DragSourceMsg msg = reinterpret_cast<const DragSourceMsg&>(aBuffer);
        OnMain("ZenEmbed::DragSource", [this, msg] { OnDragSource(msg); });
      }
      break;
    default:
      EMBED_LOG("unknown message %d", header.msgh_id);
      break;
  }
}

bool Channel::PeerMatchesRequirement(const audit_token_t& aToken,
                                     const nsACString& aRequirement) {
  CFDataRef tokenData = CFDataCreate(
      nullptr, reinterpret_cast<const UInt8*>(&aToken), sizeof(aToken));
  const void* keys[] = {kSecGuestAttributeAudit};
  const void* values[] = {tokenData};
  CFDictionaryRef attributes =
      CFDictionaryCreate(nullptr, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
                         &kCFTypeDictionaryValueCallBacks);
  CFRelease(tokenData);
  SecCodeRef code = nullptr;
  OSStatus status = SecCodeCopyGuestWithAttributes(nullptr, attributes,
                                                   kSecCSDefaultFlags, &code);
  CFRelease(attributes);
  if (status != errSecSuccess) {
    return false;
  }
  CFStringRef requirementString = CFStringCreateWithBytes(
      nullptr, reinterpret_cast<const UInt8*>(aRequirement.BeginReading()),
      aRequirement.Length(), kCFStringEncodingUTF8, false);
  SecRequirementRef requirement = nullptr;
  status = SecRequirementCreateWithString(requirementString, kSecCSDefaultFlags,
                                          &requirement);
  CFRelease(requirementString);
  if (status == errSecSuccess) {
    status = SecCodeCheckValidity(code, kSecCSDefaultFlags, requirement);
    CFRelease(requirement);
  }
  CFRelease(code);
  return status == errSecSuccess;
}

// The requirement for zen.embed.peer-cdhash: `cdhash H"<40 hex>"`, or empty
// when the pref is not a code directory hash.
nsCString Channel::CdhashRequirement() {
  nsAutoCString cdhash;
  Preferences::GetCString("zen.embed.peer-cdhash", cdhash);
  if (cdhash.Length() != 40) {
    return ""_ns;
  }
  for (char c : cdhash.View()) {
    if (!(('0' <= c && c <= '9') || ('a' <= c && c <= 'f'))) {
      return ""_ns;
    }
  }
  return "cdhash H\""_ns + cdhash + "\""_ns;
}

void Channel::Authenticate(const audit_token_t& aToken) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mAuthenticated) {
    return;
  }
  // audit_token_t: val[1] is the effective uid.
  if (uid_t(aToken.val[1]) != geteuid()) {
    EMBED_LOG("rejecting embedder pid %u: other user", aToken.val[5]);
    return;
  }
  nsAutoCString requirement;
  Preferences::GetCString("zen.embed.peer-requirement", requirement);
  if (requirement.IsEmpty()) {
    requirement = CdhashRequirement();
  }
  bool trusted =
      requirement.IsEmpty()
          ? Preferences::GetBool("zen.embed.allow-unsigned-peer", false)
          : PeerMatchesRequirement(aToken, requirement);
  if (!trusted) {
    EMBED_LOG("rejecting embedder pid %u: code signature", aToken.val[5]);
    return;
  }
  mPeerPid = int32_t(aToken.val[5]);
  mPeerPidVersion = aToken.val[7];
  mAuthenticated = true;
  EMBED_LOG("embedder pid %u authenticated (%s)", aToken.val[5],
            requirement.IsEmpty() ? "unsigned, development pref"
                                  : requirement.get());
  WatchPeer(pid_t(aToken.val[5]));
  for (const auto& entry : mWindows) {
    if (entry.mVisible) {
      SendWindow(entry);
    }
    entry.mExporter->Flush();
  }
}

void Channel::WatchPeer(pid_t aPid) {
  mPeerExit = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, aPid,
                                     DISPATCH_PROC_EXIT, mQueue);
  if (!mPeerExit) {
    return;
  }
  dispatch_source_set_event_handler(mPeerExit, ^{
    EMBED_LOG("embedder pid %d exited, quitting", aPid);
    mAuthenticated = false;
    dispatch_source_cancel(mPeerExit);
    OnMain("ZenEmbed::PeerExited", [] { QuitForEmbedder(); });
  });
  dispatch_resume(mPeerExit);
  // Exited between the handshake and the watch: the source never fires.
  if (kill(aPid, 0) != 0 && errno == ESRCH) {
    OnMain("ZenEmbed::PeerExited", [] { QuitForEmbedder(); });
  }
}

Channel::Entry* Channel::FindEntry(uint32_t aWindowId) {
  for (auto& entry : mWindows) {
    if (entry.mId == aWindowId) {
      return &entry;
    }
  }
  return nullptr;
}

Channel::Entry* Channel::FindEntry(nsPIDOMWindowOuter* aWindow) {
  for (auto& entry : mWindows) {
    if (OuterWindowOf(entry.mWindow) == aWindow) {
      return &entry;
    }
  }
  return nullptr;
}

RefPtr<WindowExporter> Channel::FindExporter(uint32_t aWindowId) {
  MutexAutoLock lock(mExportersMutex);
  for (const auto& [id, exporter] : mExporters) {
    if (id == aWindowId) {
      return exporter;
    }
  }
  return nullptr;
}

void Channel::AddWindow(nsCocoaWindow* aWindow, NativeLayerRootCA* aLayerRoot) {
  Entry entry;
  entry.mId = mNextWindowId++;
  entry.mWindow = aWindow;
  entry.mLayerRoot = aLayerRoot;
  entry.mExporter = new WindowExporter(entry.mId);
  if (sBrowserPaneForNextWindow) {
    // OnOpenBrowserWindow's window: its pane is known now (there is no
    // zen-embed.js to name it).
    entry.mPane = sBrowserPaneForNextWindow;
    entry.mBrowser = true;
    entry.mReady = true;
    sBrowserPaneForNextWindow = 0;
  } else if (sStrayNextWindow) {
    entry.mStray = true;
    sStrayNextWindow = false;
  }
  {
    MutexAutoLock lock(mExportersMutex);
    mExporters.AppendElement(std::make_pair(entry.mId, entry.mExporter));
  }
  aLayerRoot->SetObserver(entry.mExporter);
  EMBED_LOG("window %u created%s", entry.mId,
            entry.mBrowser ? " (browser window)"
            : entry.mStray ? " (stray browser window)"
                           : "");
  mWindows.AppendElement(std::move(entry));
}

void Channel::SetWindowVisible(nsCocoaWindow* aWindow, bool aVisible) {
  for (auto& entry : mWindows) {
    if (entry.mWindow == aWindow) {
      entry.mVisible = aVisible;
      if (aVisible && (entry.mBrowser || entry.mStray) && !entry.mAnnounced) {
        // Its chrome (ZenEmbedBrowser.sys.mjs) marks the document as
        // embedded: the embedder's frame, not a window of its own on screen.
        // Not from inside the widget's Show: once that is over.
        entry.mAnnounced = true;
        nsCOMPtr<nsPIDOMWindowOuter> window = OuterWindowOf(entry.mWindow);
        if (window) {
          const char* topic = entry.mStray ? "zen-embed-stray-window"
                                           : "zen-embed-browser-window";
          NS_DispatchToMainThread(NS_NewRunnableFunction(
              "ZenEmbed::AnnounceBrowserWindow", [window, topic] {
                if (nsCOMPtr<nsIObserverService> obs =
                        services::GetObserverService()) {
                  obs->NotifyObservers(
                      static_cast<mozIDOMWindowProxy*>(window.get()), topic,
                      nullptr);
                }
              }));
        }
      }
      if (mAuthenticated) {
        SendWindow(entry);
      }
      entry.mExporter->SetVisible(aVisible && !entry.mStray);
      return;
    }
  }
}

void Channel::RemoveWindow(nsCocoaWindow* aWindow) {
  for (size_t i = 0; i < mWindows.Length(); i++) {
    Entry& entry = mWindows[i];
    if (entry.mWindow != aWindow) {
      continue;
    }
    entry.mLayerRoot->SetObserver(nullptr);
    entry.mExporter->Reset();
    entry.mVisible = false;
    if (mAuthenticated) {
      SendWindow(entry);
    }
    {
      MutexAutoLock lock(mExportersMutex);
      mExporters.RemoveElementsBy(
          [&](const auto& pair) { return pair.first == entry.mId; });
    }
    if (mDrag && mDrag->mWindowId == entry.mId) {
      // Gone with its window; the next press ends Gecko's stale session.
      SendDragStatus(entry.mId, NSDragOperationNone, kDragStatusEnded);
      mDrag = nullptr;
    }
    if (mTargetWindow == entry.mId) {
      [mTargetInfo release];
      mTargetInfo = nil;
      mTargetWindow = 0;
    }
    mWindows.RemoveElementAt(i);
    return;
  }
}

void Channel::OnChromeReady(nsPIDOMWindowOuter* aWindow, uint32_t aPane,
                            uint64_t aOpener) {
  Entry* entry = FindEntry(aWindow);
  if (!entry) {
    return;
  }
  entry->mPane = aPane;
  entry->mReady = true;
  if (aOpener) {
    for (const auto& other : mWindows) {
      nsCOMPtr<nsPIDOMWindowOuter> outer = OuterWindowOf(other.mWindow);
      if (outer && outer->WindowID() == aOpener) {
        entry->mOpener = other.mId;
        break;
      }
    }
  }
  EMBED_LOG("window %u is pane %u (opener window %u)", entry->mId, aPane,
            entry->mOpener);
  if (mAuthenticated) {
    SendWindow(*entry);
  }
}

void Channel::OnChromeLocation(nsPIDOMWindowOuter* aWindow,
                               const nsACString& aData) {
  Entry* entry = FindEntry(aWindow);
  if (!entry || !mAuthenticated) {
    return;
  }
  // "flags\nurl\ntitle"
  int32_t first = aData.FindChar('\n');
  int32_t second = first < 0 ? -1 : aData.FindChar('\n', first + 1);
  if (second < 0) {
    return;
  }
  nsresult rv;
  uint32_t flags = nsAutoCString(Substring(aData, 0, first)).ToUnsignedInteger(&rv);
  if (NS_FAILED(rv)) {
    return;
  }
  const nsDependentCSubstring url = Substring(aData, first + 1, second - first - 1);
  nsDependentCSubstring title = Substring(aData, second + 1);
  if (url.Length() > kMaxText) {
    return;  // The embedder could not tell where the page is.
  }
  // Titles are cut to what is left (at a UTF-8 character boundary).
  uint32_t titleLength = std::min<uint32_t>(title.Length(), kMaxText - url.Length());
  while (titleLength > 0 && titleLength < title.Length() &&
         (uint8_t(title[titleLength]) & 0xC0) == 0x80) {
    titleLength--;
  }
  auto msg = MakeUnique<LocationMsg>();
  msg->header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, 0);
  msg->header.msgh_id = kMsgLocation;
  msg->windowId = entry->mId;
  msg->flags = flags;
  msg->urlLength = url.Length();
  msg->titleLength = titleLength;
  memcpy(msg->text, url.BeginReading(), url.Length());
  memcpy(msg->text + url.Length(), title.BeginReading(), titleLength);
  uint32_t size = offsetof(LocationMsg, text) + url.Length() + titleLength;
  Send(&msg->header, (size + 3) & ~3u);
}

void Channel::SendWindow(const Entry& aEntry) {
  if (aEntry.mStray) {
    return;
  }
  NSWindow* window = (NSWindow*)aEntry.mWindow->GetNativeData(NS_NATIVE_WINDOW);
  if (!window) {
    return;
  }
  NSRect content = [window contentRectForFrameRect:window.frame];
  WindowMsg msg{};
  msg.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, 0);
  msg.header.msgh_id = kMsgWindow;
  msg.windowId = aEntry.mId;
  msg.visible = aEntry.mVisible ? 1 : 0;
  msg.width = content.size.width;
  msg.height = content.size.height;
  msg.scale = aEntry.mWindow->BackingScaleFactor();
  msg.pane = aEntry.mPane;
  msg.opener = aEntry.mOpener;
  Send(&msg.header, sizeof(msg));
}

void Channel::OnMouse(const MouseMsg& aMsg) {
  Entry* entry = FindEntry(aMsg.windowId);
  if (!entry) {
    return;
  }
  nsCocoaWindow* widget = entry->mWindow;
  NSWindow* window = (NSWindow*)widget->GetNativeData(NS_NATIVE_WINDOW);
  NSView* view = (NSView*)widget->GetNativeData(NS_NATIVE_WIDGET);
  if (!window || !view) {
    return;
  }
  if (window.windowNumber <= 0) {
    // Gecko maps button events through [NSEvent window]; see nsCocoaWindow's
    // defer:!mIsEmbedded.
    EMBED_LOG("window %u has no window device", aMsg.windowId);
  }

  CGFloat scale = widget->BackingScaleFactor();
  if (aMsg.kind == kMouseExit) {
    // The pointer left the pane: hover state goes, as when it leaves a window.
    RefPtr<nsCocoaWindow> grip(widget);
    WidgetMouseEvent event(true, eMouseExitFromWidget, widget,
                           WidgetMouseEvent::eReal);
    event.mRefPoint =
        LayoutDeviceIntPoint::Round(float(aMsg.x * scale), float(aMsg.y * scale));
    event.mExitFrom = Some(WidgetMouseEvent::ePlatformTopLevel);
    grip->DispatchInputEvent(&event);
    return;
  }
  if (mDrag && mDrag->mWindowId == entry->mId && !mDrag->mCarried &&
      aMsg.button < 0) {
    // No button is held any more, so the release that ended the drag was
    // lost: the drag is over (AppKit's would be too).
    CancelDrag(nil);
  }
  if (aMsg.kind == kMouseMove && aMsg.button < 0) {
    // AppKit derives hover positions from the real cursor
    // (nsCocoaUtils::ScreenLocationForEvent), so dispatch hover directly.
    RefPtr<nsCocoaWindow> grip(widget);
    WidgetMouseEvent event(true, eMouseMove, widget, WidgetMouseEvent::eReal);
    event.mRefPoint =
        LayoutDeviceIntPoint::Round(float(aMsg.x * scale), float(aMsg.y * scale));
    event.mModifiers = GeckoModifiers(aMsg.modifiers);
    grip->DispatchInputEvent(&event);
    return;
  }

  NSEventType type;
  switch (aMsg.kind) {
    case kMouseDown:
      type = aMsg.button == 1   ? NSEventTypeRightMouseDown
             : aMsg.button == 2 ? NSEventTypeOtherMouseDown
                                : NSEventTypeLeftMouseDown;
      break;
    case kMouseUp:
      type = aMsg.button == 1   ? NSEventTypeRightMouseUp
             : aMsg.button == 2 ? NSEventTypeOtherMouseUp
                                : NSEventTypeLeftMouseUp;
      break;
    case kMouseMove:
      type = aMsg.button == 1   ? NSEventTypeRightMouseDragged
             : aMsg.button == 2 ? NSEventTypeOtherMouseDragged
                                : NSEventTypeLeftMouseDragged;
      break;
    default:
      return;
  }
  NSRect content = [window contentRectForFrameRect:window.frame];
  NSPoint location = NSMakePoint(aMsg.x, content.size.height - aMsg.y);
  NSEvent* event =
      [NSEvent mouseEventWithType:type
                         location:location
                    modifierFlags:NSEventModifierFlags(aMsg.modifiers)
                        timestamp:NSProcessInfo.processInfo.systemUptime
                     windowNumber:window.windowNumber
                          context:nil
                      eventNumber:0
                       clickCount:aMsg.clickCount
                         pressure:aMsg.kind == kMouseUp ? 0.0 : 1.0];
  if (!event) {
    return;
  }
  mMouseWindow = entry->mId;
  mMouse = location;
  if (mDrag && mDrag->mWindowId == entry->mId) {
    // The window's drag has the pointer (the embedder's AppKit drag, once it
    // carries it): AppKit sends no mouse events to a view while it drags.
    if (!mDrag->mCarried && (type == NSEventTypeLeftMouseDragged ||
                             type == NSEventTypeLeftMouseUp)) {
      DragMouse(event, location);
      return;
    }
    if (type != NSEventTypeLeftMouseDown &&
        type != NSEventTypeRightMouseDown &&
        type != NSEventTypeOtherMouseDown) {
      return;
    }
    // A press: whatever ended the drag never came.
    CancelDrag(nil);
  }
  // Straight to the view: [NSApp sendEvent:] would activate Nightly and take
  // focus away from the embedder.
  switch (type) {
    case NSEventTypeLeftMouseDown:
      [view mouseDown:event];
      break;
    case NSEventTypeLeftMouseUp:
      [view mouseUp:event];
      break;
    case NSEventTypeLeftMouseDragged:
      [view mouseDragged:event];
      break;
    case NSEventTypeRightMouseDown:
      [view rightMouseDown:event];
      break;
    case NSEventTypeRightMouseUp:
      [view rightMouseUp:event];
      break;
    case NSEventTypeRightMouseDragged:
      [view rightMouseDragged:event];
      break;
    case NSEventTypeOtherMouseDown:
      [view otherMouseDown:event];
      break;
    case NSEventTypeOtherMouseUp:
      [view otherMouseUp:event];
      break;
    case NSEventTypeOtherMouseDragged:
      [view otherMouseDragged:event];
      break;
    default:
      break;
  }
}

void Channel::OnWheel(const WheelMsg& aMsg) {
  Entry* entry = FindEntry(aMsg.windowId);
  if (!entry) {
    return;
  }
  // As -[ChildView scrollWheel:], from the embedder's NSEvent fields: phased
  // precise scrolling (trackpads, Magic Mouse) is a pan gesture for APZ, with
  // momentum; the rest are wheel events in pixels or lines.
  RefPtr<nsCocoaWindow> widget(entry->mWindow);
  double scale = widget->BackingScaleFactor();
  ScreenPoint position(float(aMsg.x * scale), float(aMsg.y * scale));
  Modifiers modifiers = GeckoModifiers(aMsg.modifiers);
  TimeStamp now = TimeStamp::Now();
  bool precise = (aMsg.flags & kWheelPrecise) &&
                 Preferences::GetBool("mousewheel.enable_pixel_scrolling", true);
  NSEventPhase phase = NSEventPhase(aMsg.phase);
  NSEventPhase momentum = NSEventPhase(aMsg.momentumPhase);
  gfx::IntPoint lineOrPageDelta;
  if (precise) {
    lineOrPageDelta = -PanGestureInput::GetIntegerDeltaForEvent(
        phase == NSEventPhaseBegan, float(aMsg.lineDeltaX),
        float(aMsg.lineDeltaY));
  } else {
    // Line scrolls: the rounded-up deltaX / deltaY.
    auto roundUp = [](double aValue) {
      return int32_t(aValue < 0 ? floor(aValue) : ceil(aValue));
    };
    lineOrPageDelta =
        -gfx::IntPoint(roundUp(aMsg.lineDeltaX), roundUp(aMsg.lineDeltaY));
  }
  ScreenPoint preciseDelta;
  if (precise) {
    preciseDelta = ScreenPoint(float(-aMsg.deltaX * scale),
                               float(-aMsg.deltaY * scale));
  }

  if (precise && (phase != NSEventPhaseNone || momentum != NSEventPhaseNone)) {
    PanGestureInput::PanGestureType type;
    switch (phase) {
      case NSEventPhaseMayBegin:
        type = PanGestureInput::PANGESTURE_MAYSTART;
        break;
      case NSEventPhaseCancelled:
        type = PanGestureInput::PANGESTURE_CANCELLED;
        break;
      case NSEventPhaseBegan:
        type = PanGestureInput::PANGESTURE_START;
        break;
      case NSEventPhaseChanged:
        type = PanGestureInput::PANGESTURE_PAN;
        break;
      case NSEventPhaseEnded:
        type = PanGestureInput::PANGESTURE_END;
        break;
      default:
        switch (momentum) {
          case NSEventPhaseBegan:
            type = PanGestureInput::PANGESTURE_MOMENTUMSTART;
            break;
          case NSEventPhaseChanged:
            type = PanGestureInput::PANGESTURE_MOMENTUMPAN;
            break;
          case NSEventPhaseEnded:
          case NSEventPhaseCancelled:
            type = PanGestureInput::PANGESTURE_MOMENTUMEND;
            break;
          default:
            return;
        }
    }
    bool noDeltas = type == PanGestureInput::PANGESTURE_MAYSTART ||
                    type == PanGestureInput::PANGESTURE_CANCELLED;
    // An embed window's back/forward swipe belongs to the embedder. A browser
    // window's is its own, as in a Nightly window (ShouldConsiderStartingSwipe
    // FromEvent, nsCocoaUtils.mm): Zen's spaces switch (and a space is added)
    // with a horizontal two-finger swipe.
    bool swipe = entry->mBrowser && phase == NSEventPhaseBegan &&
                 ([NSEvent isSwipeTrackingFromScrollEventsEnabled] ||
                  Preferences::GetBool(
                      "zen.widget.macos.override-system-swipe-gestures"));
    PanGestureInput pan(type, now, position,
                        noDeltas ? ScreenPoint() : preciseDelta, modifiers,
                        PanGestureInput::IsEligibleForSwipe(swipe));
    if (!noDeltas) {
      pan.SetLineOrPageDeltas(lineOrPageDelta.x, lineOrPageDelta.y);
    }
    widget->DispatchAPZWheelInputEvent(pan);
    return;
  }
  bool smooth = !precise && nsLayoutUtils::IsSmoothScrollingEnabled() &&
                StaticPrefs::general_smoothScroll_mouseWheel();
  ScrollWheelInput wheel(
      now, modifiers,
      smooth ? ScrollWheelInput::SCROLLMODE_SMOOTH
             : ScrollWheelInput::SCROLLMODE_INSTANT,
      precise ? ScrollWheelInput::SCROLLDELTA_PIXEL
              : ScrollWheelInput::SCROLLDELTA_LINE,
      position, precise ? preciseDelta.x.value : float(lineOrPageDelta.x),
      precise ? preciseDelta.y.value : float(lineOrPageDelta.y), false,
      WheelDeltaAdjustmentStrategy::eNone);
  wheel.mLineOrPageDeltaX = lineOrPageDelta.x;
  wheel.mLineOrPageDeltaY = lineOrPageDelta.y;
  wheel.mIsMomentum = momentum != NSEventPhaseNone;
  widget->DispatchAPZWheelInputEvent(wheel);
}

void Channel::OnKey(const KeyMsg& aMsg) {
  Entry* entry = FindEntry(aMsg.windowId);
  if (!entry) {
    return;
  }
  NSWindow* window =
      (NSWindow*)entry->mWindow->GetNativeData(NS_NATIVE_WINDOW);
  NSView* view = (NSView*)entry->mWindow->GetNativeData(NS_NATIVE_WIDGET);
  if (!window || !view) {
    return;
  }
  NSString* chars =
      [NSString stringWithCharacters:aMsg.chars
                              length:std::clamp(aMsg.charCount, 0, 16)];
  NSString* unmodified =
      aMsg.unmodifiedCount > 0
          ? [NSString stringWithCharacters:aMsg.unmodifiedChars
                                    length:std::clamp(aMsg.unmodifiedCount, 0,
                                                      16)]
          : chars;
  const bool flagsChanged = aMsg.down == 2;
  NSEvent* event =
      [NSEvent keyEventWithType:flagsChanged ? NSEventTypeFlagsChanged
                                : aMsg.down  ? NSEventTypeKeyDown
                                             : NSEventTypeKeyUp
                       location:NSZeroPoint
                  modifierFlags:NSEventModifierFlags(aMsg.modifiers)
                      timestamp:NSProcessInfo.processInfo.systemUptime
                   windowNumber:window.windowNumber
                        context:nil
                     characters:chars
    charactersIgnoringModifiers:unmodified
                      isARepeat:aMsg.isRepeat != 0
                        keyCode:uint16_t(aMsg.keyCode)];
  if (!event) {
    return;
  }
  if (mDrag && mDrag->mWindowId == entry->mId && !mDrag->mCarried) {
    // While AppKit drags, the keys are the drag's: Escape cancels it, the
    // modifiers choose its operation (Option copies), the window gets none.
    if (aMsg.down == 1 && aMsg.keyCode == kEscapeKeyCode) {
      CancelDrag(event);
    } else if (flagsChanged) {
      NSPoint at = mDrag->mInfo.draggingLocation;
      DragMouse([NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged
                                   location:at
                              modifierFlags:NSEventModifierFlags(aMsg.modifiers)
                                  timestamp:NSProcessInfo.processInfo.systemUptime
                               windowNumber:window.windowNumber
                                    context:nil
                                eventNumber:0
                                 clickCount:0
                                   pressure:1.0],
                at);
    }
    return;
  }
  // Straight to Gecko's ChildView, which runs the regular path
  // (TextInputHandler, native key bindings); the window is never key, so
  // AppKit would not route the event there. Like NSApplication, offer
  // Command shortcuts as key equivalents first.
  if (flagsChanged) {
    [view flagsChanged:event];
  } else if (!aMsg.down) {
    [view keyUp:event];
  } else if (!(aMsg.modifiers & NSEventModifierFlagCommand) ||
             ![view performKeyEquivalent:event]) {
    [view keyDown:event];
  }
}

void Channel::OnText(const TextMsg& aMsg) {
  Entry* entry = FindEntry(aMsg.windowId);
  if (!entry) {
    return;
  }
  NSView* view = (NSView*)entry->mWindow->GetNativeData(NS_NATIVE_WIDGET);
  if (!view || ![view conformsToProtocol:@protocol(NSTextInputClient)]) {
    return;
  }
  NSString* text =
      [NSString stringWithCharacters:aMsg.chars
                              length:std::clamp(aMsg.count, 0, 64)];
  // Outside a key event Gecko commits it as a composition (beforeinput and
  // input, no key events), as an input method's commit.
  [(id<NSTextInputClient>)view insertText:text
                         replacementRange:NSMakeRange(NSNotFound, 0)];
}

// Whether aWindow's TextInputHandler (its view's input client) has a
// composition: one the embedder's input method started that Gecko has not
// ended.
static bool IsComposing(nsCocoaWindow* aWindow) {
  auto* handler = static_cast<mozilla::widget::TextInputHandler*>(
      aWindow->GetNativeTextEventDispatcherListener());
  return handler && handler->IsIMEComposing();
}

void Channel::OnMarkedText(const MarkedTextMsg& aMsg) {
  Entry* entry = FindEntry(aMsg.windowId);
  if (!entry) {
    return;
  }
  NSView* view = (NSView*)entry->mWindow->GetNativeData(NS_NATIVE_WIDGET);
  if (!view || ![view conformsToProtocol:@protocol(NSTextInputClient)]) {
    return;
  }
  int32_t count = std::clamp(aMsg.count, 0, 64);
  if (count == 0 && !IsComposing(entry->mWindow)) {
    // The input method ends a composition the window no longer has: Gecko
    // ended it itself (committed it as the focus moved or the window went
    // inactive, or nothing took it), or never started one. On screen AppKit
    // would not send this (Gecko's commit discards the input method's marked
    // text), and TextInputHandler can only end a composition it has (it
    // crashed: MOZ_RELEASE_ASSERT(isSome()) in
    // IMEInputHandler::DispatchCompositionCommitEvent).
    return;
  }
  NSString* text = [NSString stringWithCharacters:aMsg.chars length:count];
  int32_t start = std::clamp(aMsg.selStart, 0, count);
  int32_t length = std::clamp(aMsg.selLength, 0, count - start);
  // As the embedder's input method composes: Gecko's TextInputHandler starts,
  // updates or (with no text) ends the composition in the focused editor.
  [(id<NSTextInputClient>)view setMarkedText:text
                               selectedRange:NSMakeRange(start, length)
                            replacementRange:NSMakeRange(NSNotFound, 0)];
  if (count == 0) {
    return;
  }
  // The page lays the composition out in its process: once now (from the
  // content cache) and again once that has caught up.
  uint32_t windowId = aMsg.windowId;
  ReportTextRect(windowId);
  NS_DelayedDispatchToCurrentThread(
      NS_NewRunnableFunction("ZenEmbed::TextRect",
                             [windowId] {
                               if (sChannel) {
                                 sChannel->ReportTextRect(windowId);
                               }
                             }),
      60);
}

void Channel::ReportTextRect(uint32_t aWindowId) {
  Entry* entry = FindEntry(aWindowId);
  if (!entry || !mAuthenticated) {
    return;
  }
  NSWindow* window = (NSWindow*)entry->mWindow->GetNativeData(NS_NATIVE_WINDOW);
  NSView* view = (NSView*)entry->mWindow->GetNativeData(NS_NATIVE_WIDGET);
  if (!window || !view ||
      ![view conformsToProtocol:@protocol(NSTextInputClient)]) {
    return;
  }
  id<NSTextInputClient> client = (id<NSTextInputClient>)view;
  // The caret inside the composition (or the plain caret).
  NSRange range = [client selectedRange];
  if (range.location == NSNotFound) {
    return;
  }
  // Screen coordinates (Cocoa): the window sits where the embedder's pane is.
  NSRect rect = [client firstRectForCharacterRange:range actualRange:nullptr];
  if (NSIsEmptyRect(rect) && rect.size.height <= 0) {
    return;
  }
  NSRect content = [window contentRectForFrameRect:window.frame];
  TextRectMsg msg{};
  msg.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, 0);
  msg.header.msgh_id = kMsgTextRect;
  msg.windowId = entry->mId;
  msg.x = rect.origin.x - content.origin.x;
  msg.y = NSMaxY(content) - NSMaxY(rect);
  msg.width = rect.size.width;
  msg.height = rect.size.height;
  Send(&msg.header, sizeof(msg));
}

void Channel::CursorChanged(nsCocoaWindow* aWindow, uint32_t aCursor) {
  for (auto& entry : mWindows) {
    if (entry.mWindow != aWindow) {
      continue;
    }
    if (entry.mCursor == aCursor || !mAuthenticated) {
      return;
    }
    entry.mCursor = aCursor;
    CursorMsg msg{};
    msg.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, 0);
    msg.header.msgh_id = kMsgCursor;
    msg.windowId = entry.mId;
    msg.cursor = aCursor;
    Send(&msg.header, sizeof(msg));
    return;
  }
}

void Channel::OnFocus(const FocusMsg& aMsg) {
  Entry* entry = FindEntry(aMsg.windowId);
  if (!entry) {
    return;
  }
  if (!aMsg.focused && mDrag && mDrag->mWindowId == entry->mId &&
      !mDrag->mCarried) {
    // The embedder's window went inactive (Command-Tab): so does the drag.
    CancelDrag(nil);
  }
  if (nsIWidgetListener* listener = entry->mWindow->GetWidgetListener()) {
    if (aMsg.focused) {
      listener->WindowActivated();
    } else {
      listener->WindowDeactivated();
    }
  }
  // The embedder's window is no longer the active one (or the pane lost the
  // keyboard): a browser window's menus and panels close, as they do when a
  // Nightly window is deactivated.
  if (!aMsg.focused && entry->mBrowser) {
    RollUpPopups();
  }
}

void Channel::OnResize(const ResizeMsg& aMsg) {
  Entry* entry = FindEntry(aMsg.windowId);
  if (!entry || aMsg.width < 1 || aMsg.height < 1) {
    return;
  }
  RefPtr<nsCocoaWindow> widget(entry->mWindow);
  NSWindow* window = (NSWindow*)widget->GetNativeData(NS_NATIVE_WINDOW);
  if (!window) {
    return;
  }
  if (aMsg.flags & kResizeHasOrigin) {
    NSPoint at = [window contentRectForFrameRect:window.frame].origin;
    if (entry->mBrowser && (at.x != aMsg.screenX || at.y != aMsg.screenY)) {
      // The embedder's window moved: popups would be left where they were.
      RollUpPopups();
    }
    NSRect frame = [window frameRectForContentRect:NSMakeRect(
                                                       aMsg.screenX, aMsg.screenY,
                                                       aMsg.width, aMsg.height)];
    [window setFrame:frame display:NO];
    // The window is never ordered in, so AppKit does not tell it that the
    // screen under it changed.
    widget->BackingScaleFactorChanged();
  } else {
    [window setContentSize:NSMakeSize(aMsg.width, aMsg.height)];
  }
  SendWindow(*entry);
}

void Channel::OnCommand(uint32_t aWindowId, uint32_t aOp,
                        const nsACString& aText) {
  if (aOp == kCommandTheme) {
    constexpr char kDarkPref[] = "ui.systemUsesDarkTheme";
    if (aText.EqualsLiteral("dark") || aText.EqualsLiteral("light")) {
      Preferences::SetInt(kDarkPref, aText.EqualsLiteral("dark") ? 1 : 0);
    } else {
      Preferences::ClearUser(kDarkPref);
    }
    return;
  }
  Entry* entry = FindEntry(aWindowId);
  if (!entry || aOp < kCommandNavigate || aOp > kCommandDevice) {
    return;
  }
  nsCOMPtr<nsPIDOMWindowOuter> window = OuterWindowOf(entry->mWindow);
  nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
  if (!window || !obs) {
    return;
  }
  // "op\ntext", read by zen-embed.js in that window.
  nsAutoCString data;
  data.AppendInt(aOp);
  data.Append('\n');
  data.Append(aText);
  obs->NotifyObservers(static_cast<mozIDOMWindowProxy*>(window.get()),
                       "zen-embed-command",
                       NS_ConvertUTF8toUTF16(data).get());
}

void Channel::OnOpenWindow(uint32_t aPane) {
  nsCOMPtr<nsIWindowWatcher> watcher =
      do_GetService(NS_WINDOWWATCHER_CONTRACTID);
  if (!watcher || !aPane) {
    return;
  }
  nsAutoCString url(kEmbedDocument);
  url.AppendLiteral("?pane=");
  url.AppendInt(aPane);
  nsCOMPtr<mozIDOMWindowProxy> opened;
  nsresult rv = watcher->OpenWindow(nullptr, url, u"_blank"_ns,
                                    "chrome,dialog=no,all"_ns, nullptr,
                                    getter_AddRefs(opened));
  EMBED_LOG("open window for pane %u: %s", aPane,
            NS_SUCCEEDED(rv) ? "ok" : "failed");
}

void Channel::OnOpenBrowserWindow(uint32_t aPane) {
  nsCOMPtr<nsIWindowWatcher> watcher =
      do_GetService(NS_WINDOWWATCHER_CONTRACTID);
  if (!watcher || !aPane) {
    return;
  }
  // Created synchronously inside OpenWindow: AutoEmbedScope embeds it and
  // AddWindow takes the pane. The window's chrome is named: without
  // arguments nsWindowWatcher does not take "all" (only dialogs do), and a
  // browser.xhtml without toolbar and menubar flags is a popup window (no
  // spaces, no sidebar: ZenSpaceManager.shouldHaveWorkspaces).
  sBrowserPaneForNextWindow = aPane;
  nsCOMPtr<mozIDOMWindowProxy> opened;
  nsresult rv = watcher->OpenWindow(
      nullptr, nsDependentCString(kBrowserDocument), u"_blank"_ns,
      "chrome,dialog=no,titlebar,close,minimizable,resizable,toolbar,"
      "menubar,location,personalbar,status,scrollbars"_ns,
      nullptr, getter_AddRefs(opened));
  sBrowserPaneForNextWindow = 0;
  EMBED_LOG("open browser window for pane %u: %s", aPane,
            NS_SUCCEEDED(rv) ? "ok" : "failed");
}

bool Channel::IsEmbedDocumentWindow(nsIWidget* aWidget) {
  for (const auto& entry : mWindows) {
    if (static_cast<nsIWidget*>(entry.mWindow) == aWidget) {
      return !entry.mBrowser && !entry.mStray;
    }
  }
  return false;
}

bool Channel::HasBrowserWindow() const {
  for (const auto& entry : mWindows) {
    if (entry.mBrowser) {
      return true;
    }
  }
  return false;
}

void Channel::OnScript(uint32_t aWindowId, uint32_t aRequestId, uint32_t aKind,
                       const nsACString& aSource, const nsACString& aArgs) {
  Entry* entry = FindEntry(aWindowId);
  nsCOMPtr<nsPIDOMWindowOuter> window =
      entry ? OuterWindowOf(entry->mWindow) : nullptr;
  nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
  // mReady once zen-embed.js listens (zen-embed-ready): every request that
  // reaches it is answered.
  if (!window || !obs || !entry->mReady) {
    SendScriptResult(aWindowId, aRequestId, kScriptNoPage,
                     "The pane's window is not ready yet."_ns);
    return;
  }
  if (aKind != kScriptPage && aKind != kScriptIsolated) {
    SendScriptResult(aWindowId, aRequestId, kScriptError,
                     "Unknown script kind."_ns);
    return;
  }
  // "requestId\nkind\nargsLength\n" then the arguments and the source (UTF-16
  // lengths), read by zen-embed.js in that window.
  NS_ConvertUTF8toUTF16 args(aArgs);
  nsAutoString data;
  data.AppendInt(aRequestId);
  data.Append(u'\n');
  data.AppendInt(aKind);
  data.Append(u'\n');
  data.AppendInt(uint32_t(args.Length()));
  data.Append(u'\n');
  data.Append(args);
  AppendUTF8toUTF16(aSource, data);
  obs->NotifyObservers(static_cast<mozIDOMWindowProxy*>(window.get()),
                       "zen-embed-script", data.get());
}

void Channel::OnChromeScriptResult(nsPIDOMWindowOuter* aWindow,
                                   const nsACString& aData) {
  Entry* entry = FindEntry(aWindow);
  int32_t first = aData.FindChar('\n');
  int32_t second = first < 0 ? -1 : aData.FindChar('\n', first + 1);
  if (!entry || second < 0) {
    return;
  }
  nsresult rv1, rv2;
  uint32_t requestId =
      nsAutoCString(Substring(aData, 0, first)).ToUnsignedInteger(&rv1);
  uint32_t status =
      nsAutoCString(Substring(aData, first + 1, second - first - 1))
          .ToUnsignedInteger(&rv2);
  if (NS_FAILED(rv1) || NS_FAILED(rv2)) {
    return;
  }
  SendScriptResult(entry->mId, requestId, status, Substring(aData, second + 1));
}

void Channel::SendScriptResult(uint32_t aWindowId, uint32_t aRequestId,
                               uint32_t aStatus, const nsACString& aText) {
  if (aText.Length() > kMaxScript) {
    SendOutOfLine(kMsgScriptResult, aWindowId, aRequestId, kScriptError,
                  "The result is larger than the embed channel carries."_ns);
    return;
  }
  SendOutOfLine(kMsgScriptResult, aWindowId, aRequestId, aStatus, aText);
}

void Channel::SendOutOfLine(mach_msg_id_t aId, uint32_t aWindowId,
                            uint32_t aField1, uint32_t aField2,
                            const nsACString& aText) {
  if (!mAuthenticated || aText.Length() > kMaxScript) {
    return;
  }
  // Out of line, in pages of its own: the kernel moves them to the embedder
  // (deallocate), and mach_msg_destroy frees them if the send fails.
  vm_address_t address = 0;
  uint32_t length = aText.Length();
  if (length > 0) {
    if (vm_allocate(mach_task_self(), &address, length, VM_FLAGS_ANYWHERE) !=
        KERN_SUCCESS) {
      EMBED_LOG("no memory for message %d", aId);
      return;
    }
    memcpy(reinterpret_cast<void*>(address), aText.BeginReading(), length);
  }
  ScriptResultMsg msg{};
  msg.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0,
                                            MACH_MSGH_BITS_COMPLEX);
  msg.header.msgh_id = aId;
  msg.body.msgh_descriptor_count = 1;
  msg.data.address = reinterpret_cast<void*>(address);
  msg.data.size = length;
  msg.data.deallocate = length > 0;
  msg.data.copy = MACH_MSG_VIRTUAL_COPY;
  msg.data.type = MACH_MSG_OOL_DESCRIPTOR;
  msg.windowId = aWindowId;
  msg.requestId = aField1;
  msg.status = aField2;
  msg.length = length;
  // The embedder waits for these: give a busy queue (frames) a moment.
  if (!Send(&msg.header, sizeof(msg), 2000)) {
    EMBED_LOG("message %d (%u) could not be sent", aId, aField1);
  }
}

void Channel::OnChromePopup(nsPIDOMWindowOuter* aWindow,
                            const nsACString& aData) {
  // "popupId\njson"
  Entry* entry = FindEntry(aWindow);
  int32_t newline = aData.FindChar('\n');
  if (!entry || newline < 0) {
    return;
  }
  nsresult rv;
  uint32_t popupId =
      nsAutoCString(Substring(aData, 0, newline)).ToUnsignedInteger(&rv);
  if (NS_SUCCEEDED(rv)) {
    SendOutOfLine(kMsgPopup, entry->mId, popupId, 0,
                  Substring(aData, newline + 1));
  }
}

void Channel::OnChromePopupClosed(nsPIDOMWindowOuter* aWindow,
                                  const nsACString& aData) {
  Entry* entry = FindEntry(aWindow);
  nsresult rv;
  uint32_t popupId = nsAutoCString(aData).ToUnsignedInteger(&rv);
  if (!entry || NS_FAILED(rv) || !mAuthenticated) {
    return;
  }
  PopupClosedMsg msg{};
  msg.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, 0);
  msg.header.msgh_id = kMsgPopupClosed;
  msg.windowId = entry->mId;
  msg.popupId = popupId;
  Send(&msg.header, sizeof(msg), 2000);
}

void Channel::OnPopupChoice(const PopupChoiceMsg& aMsg) {
  Entry* entry = FindEntry(aMsg.windowId);
  nsCOMPtr<nsPIDOMWindowOuter> window =
      entry ? OuterWindowOf(entry->mWindow) : nullptr;
  nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
  if (!window || !obs) {
    return;
  }
  // "popupId\nindex", read by zen-embed.js in that window.
  nsAutoString data;
  data.AppendInt(aMsg.popupId);
  data.Append(u'\n');
  data.AppendInt(aMsg.index);
  obs->NotifyObservers(static_cast<mozIDOMWindowProxy*>(window.get()),
                       "zen-embed-popup-choice", data.get());
}

bool Channel::SplitId(const nsACString& aData, uint32_t* aId,
                      nsDependentCSubstring* aRest) {
  int32_t newline = aData.FindChar('\n');
  nsresult rv;
  *aId = nsAutoCString(Substring(aData, 0, newline < 0 ? aData.Length()
                                                       : uint32_t(newline)))
             .ToUnsignedInteger(&rv);
  if (NS_FAILED(rv)) {
    return false;
  }
  aRest->Rebind(aData, newline < 0 ? aData.Length() : uint32_t(newline) + 1);
  return true;
}

void Channel::OnChromeDialog(nsPIDOMWindowOuter* aWindow,
                             const nsACString& aData) {
  Entry* entry = FindEntry(aWindow);
  uint32_t id;
  nsDependentCSubstring json;
  if (entry && SplitId(aData, &id, &json)) {
    SendOutOfLine(kMsgDialog, entry->mId, id, 0, json);
  }
}

void Channel::OnChromeDialogClosed(nsPIDOMWindowOuter* aWindow,
                                   const nsACString& aData) {
  Entry* entry = FindEntry(aWindow);
  uint32_t id;
  nsDependentCSubstring rest;
  if (!entry || !mAuthenticated || !SplitId(aData, &id, &rest)) {
    return;
  }
  DialogIdMsg msg{};
  msg.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, 0);
  msg.header.msgh_id = kMsgDialogClosed;
  msg.windowId = entry->mId;
  msg.dialogId = id;
  Send(&msg.header, sizeof(msg), 2000);
}

void Channel::OnChromeDownload(nsPIDOMWindowOuter* aWindow,
                               const nsACString& aData) {
  Entry* entry = aWindow ? FindEntry(aWindow) : nullptr;
  uint32_t id;
  nsDependentCSubstring json;
  if (SplitId(aData, &id, &json)) {
    SendOutOfLine(kMsgDownload, entry ? entry->mId : 0, id, 0, json);
  }
}

void Channel::OnDialogReply(uint32_t aWindowId, uint32_t aDialogId,
                            const nsACString& aJson) {
  Entry* entry = FindEntry(aWindowId);
  nsCOMPtr<nsPIDOMWindowOuter> window =
      entry ? OuterWindowOf(entry->mWindow) : nullptr;
  nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
  if (!window || !obs) {
    return;
  }
  // "id\njson", read by ZenEmbedDialogs (only for that window's question).
  nsAutoCString data;
  data.AppendInt(aDialogId);
  data.Append('\n');
  data.Append(aJson);
  obs->NotifyObservers(static_cast<mozIDOMWindowProxy*>(window.get()),
                       "zen-embed-dialog-reply",
                       NS_ConvertUTF8toUTF16(data).get());
}

void Channel::OnDownloadCancel(uint32_t aWindowId, uint32_t aDialogId) {
  nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
  if (!obs) {
    return;
  }
  Entry* entry = aWindowId ? FindEntry(aWindowId) : nullptr;
  nsCOMPtr<nsPIDOMWindowOuter> window =
      entry ? OuterWindowOf(entry->mWindow) : nullptr;
  nsAutoString data;
  data.AppendInt(aDialogId);
  obs->NotifyObservers(
      window ? static_cast<mozIDOMWindowProxy*>(window.get()) : nullptr,
      "zen-embed-download-cancel", data.get());
}

// ── Drags ──

Channel::Drag::~Drag() {
  if (mTimer) {
    mTimer->Cancel();
  }
  [mView release];
  [mInfo release];
}

// Named pasteboards are the user's, shared by every process: this one is this
// runtime's.
static NSString* DragPasteboardName() {
  return [NSString
      stringWithFormat:@"org.mozilla.nightly.embed-drag.%d", int(getpid())];
}

bool Channel::BeginDrag(NSView* aView, NSArray<NSDraggingItem*>* aItems) {
  Entry* entry = nullptr;
  for (auto& candidate : mWindows) {
    if (candidate.mWindow &&
        candidate.mWindow->GetNativeData(NS_NATIVE_WIDGET) == aView) {
      entry = &candidate;
      break;
    }
  }
  NSWindow* window = aView.window;
  if (!entry || !window || !aItems.count) {
    return false;
  }
  // Gecko runs one drag at a time, so one still here lost its session.
  mDrag = nullptr;

  // The drag's data as AppKit's drag pasteboard would have it (promised by
  // the view): the drop reads it there (globalDragPboard), and so does the
  // embedder for a drag it carries on.
  NSString* name = DragPasteboardName();
  NSPasteboard* pasteboard = [NSPasteboard pasteboardWithName:name];
  [pasteboard clearContents];
  NSMutableArray* writers = [NSMutableArray arrayWithCapacity:aItems.count];
  for (NSDraggingItem* item in aItems) {
    [writers addObject:item.item];
  }
  [pasteboard writeObjects:writers];
  [globalDragPboard release];
  globalDragPboard = [pasteboard retain];

  NSSize size = [window contentRectForFrameRect:window.frame].size;
  NSPoint press = gLastDragMouseDownEvent
                      ? gLastDragMouseDownEvent.locationInWindow
                      : mMouse;
  auto drag = MakeUnique<Drag>();
  drag->mWindowId = entry->mId;
  drag->mWidget = entry->mWindow;
  drag->mView = [(ChildView*)aView retain];
  drag->mInfo = [[ZenEmbedDragInfo alloc] initWithWindow:window
                                               pasteboard:pasteboard
                                                   source:aView
                                               operations:NSDragOperationEvery
                                                 sequence:++mDragSequence];
  [drag->mInfo moveTo:mMouseWindow == entry->mId ? mMouse : press
                event:gLastDragMouseDownEvent];
  drag->mMovedAt = NSProcessInfo.processInfo.systemUptime;
  NS_NewTimerWithCallback(
      getter_AddRefs(drag->mTimer),
      [](nsITimer*) {
        @autoreleasepool {
          if (sChannel) {
            sChannel->DragTick();
          }
        }
      },
      kDragRepeatMs, nsITimer::TYPE_REPEATING_SLACK, "ZenEmbed::DragOver"_ns);
  mDrag = std::move(drag);
  EMBED_LOG("drag in window %u", entry->mId);
  SendDragStarted(*entry, aItems.firstObject,
                  NSMakePoint(press.x, size.height - press.y), name);
  return true;
}

// The pointer moved (or let go: aEvent a mouse up) to aLocation during the
// window's own drag: AppKit's destination calls on the window's view, as if
// the window were on screen under the pointer.
void Channel::DragMouse(NSEvent* aEvent, NSPoint aLocation) {
  Drag* drag = mDrag.get();
  ChildView* view = [[drag->mView retain] autorelease];
  ZenEmbedDragInfo* info = [[drag->mInfo retain] autorelease];
  // Gecko may have ended the session itself (a stale one): the drag is over.
  nsCOMPtr<nsIDragService> service =
      do_GetService("@mozilla.org/widget/dragservice;1");
  nsCOMPtr<nsIDragSession> session;
  if (service) {
    service->GetCurrentSession(drag->mWidget, getter_AddRefs(session));
  }
  if (!session) {
    SendDragStatus(drag->mWindowId, NSDragOperationNone, kDragStatusEnded);
    mDrag = nullptr;
    return;
  }
  NSWindow* window = view.window;
  NSSize size = [window contentRectForFrameRect:window.frame].size;
  const bool inside = aLocation.x >= 0 && aLocation.y >= 0 &&
                      aLocation.x < size.width && aLocation.y < size.height;
  const bool release = aEvent.type == NSEventTypeLeftMouseUp;
  [info moveTo:aLocation event:aEvent];
  drag->mMovedAt = NSProcessInfo.processInfo.systemUptime;
  if (!release) {
    // As draggingSession:movedToPoint: does (the drag popup, its image).
    NSPoint screen = [window convertPointToScreen:aLocation];
    session->DragMoved(int32_t(screen.x), int32_t(screen.y));
    if (mDrag.get() != drag) {
      return;
    }
  }
  if (inside) {
    NSDragOperation operation = drag->mOver ? [view draggingUpdated:info]
                                            : [view draggingEntered:info];
    if (mDrag.get() != drag) {
      return;
    }
    drag->mOver = true;
    drag->mOperation = operation;
  } else if (drag->mOver) {
    drag->mOver = false;
    drag->mOperation = NSDragOperationNone;
    [view draggingExited:info];
    if (mDrag.get() != drag) {
      return;
    }
  }
  if (!release) {
    SendDragStatus(drag->mWindowId, drag->mOperation, 0);
    return;
  }
  // The drop, as AppKit makes it: only where the last update accepted one.
  NSDragOperation operation = NSDragOperationNone;
  if (drag->mOver) {
    drag->mOver = false;
    if (drag->mOperation == NSDragOperationNone) {
      [view draggingExited:info];
    } else if ([view performDragOperation:info]) {
      operation = drag->mOperation;
    }
    if (mDrag.get() != drag) {
      return;
    }
  }
  EndDrag(aLocation, operation, aEvent);
  // The press is over for the view too; after a drag its mouseUp: only
  // forgets it.
  [view mouseUp:aEvent];
}

void Channel::DragTick() {
  Drag* drag = mDrag.get();
  if (!drag || drag->mCarried || !drag->mOver ||
      NSProcessInfo.processInfo.systemUptime - drag->mMovedAt <
          kDragRepeatMs / 1000.0) {
    return;
  }
  ZenEmbedDragInfo* info = [[drag->mInfo retain] autorelease];
  DragMouse(info.zenEmbedEvent, info.draggingLocation);
}

// All cancellation paths (including focus loss) must report user cancellation,
// not an unsuccessful drop: tab dragend otherwise creates a split view.
void Channel::CancelDrag(NSEvent* aEvent) {
  Drag* drag = mDrag.get();
  ZenEmbedDragInfo* info = [[drag->mInfo retain] autorelease];
  if (drag->mOver) {
    drag->mOver = false;
    ChildView* view = [[drag->mView retain] autorelease];
    [view draggingExited:info];
    if (mDrag.get() != drag) {
      return;
    }
  }
  if (!aEvent || aEvent.type != NSEventTypeKeyDown ||
      aEvent.keyCode != kEscapeKeyCode) {
    NSEvent* lastEvent = info.zenEmbedEvent;
    aEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
                            location:info.draggingLocation
                       modifierFlags:lastEvent.modifierFlags
                           timestamp:NSProcessInfo.processInfo.systemUptime
                        windowNumber:drag->mView.window.windowNumber
                             context:nil
                          characters:@"\x1b"
         charactersIgnoringModifiers:@"\x1b"
                           isARepeat:NO
                             keyCode:kEscapeKeyCode];
  }
  EndDrag(info.draggingLocation, NSDragOperationNone, aEvent);
}

void Channel::EndDrag(NSPoint aLocation, NSDragOperation aOperation,
                      NSEvent* aEvent) {
  ChildView* view = [[mDrag->mView retain] autorelease];
  uint32_t windowId = mDrag->mWindowId;
  mDrag = nullptr;
  EMBED_LOG("drag in window %u ended: operation %lu", windowId,
            (unsigned long)aOperation);
  [view endDragSessionAt:aLocation operation:aOperation event:aEvent];
  SendDragStatus(windowId, aOperation, kDragStatusEnded);
}

void Channel::OnDragSource(const DragSourceMsg& aMsg) {
  Drag* drag = mDrag.get();
  if (!drag || drag->mWindowId != aMsg.windowId) {
    return;
  }
  NSWindow* window = drag->mView.window;
  NSSize size = [window contentRectForFrameRect:window.frame].size;
  NSPoint location = NSMakePoint(aMsg.x, size.height - aMsg.y);
  if (aMsg.state == kDragCarried) {
    // The embedder's AppKit drag has the pointer now, outside the pane.
    if (drag->mOver) {
      drag->mOver = false;
      ChildView* view = [[drag->mView retain] autorelease];
      [view draggingExited:[[drag->mInfo retain] autorelease]];
      if (mDrag.get() != drag) {
        return;
      }
    }
    drag->mCarried = true;
    return;
  }
  if (aMsg.state != kDragEnded && aMsg.state != kDragCancelled) {
    return;
  }
  // What ended the drag, as AppKit's end of a dragging session sees it:
  // Escape for a cancelled one.
  NSEvent* event =
      aMsg.state == kDragCancelled
          ? [NSEvent keyEventWithType:NSEventTypeKeyDown
                             location:location
                        modifierFlags:NSEventModifierFlags(aMsg.modifiers)
                            timestamp:NSProcessInfo.processInfo.systemUptime
                         windowNumber:window.windowNumber
                              context:nil
                           characters:@"\x1b"
          charactersIgnoringModifiers:@"\x1b"
                            isARepeat:NO
                              keyCode:kEscapeKeyCode]
          : [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp
                               location:location
                          modifierFlags:NSEventModifierFlags(aMsg.modifiers)
                              timestamp:NSProcessInfo.processInfo.systemUptime
                           windowNumber:window.windowNumber
                                context:nil
                            eventNumber:0
                             clickCount:1
                               pressure:0.0];
  EndDrag(location,
          aMsg.state == kDragCancelled ? NSDragOperationNone
                                       : NSDragOperation(aMsg.operation),
          event);
}

void Channel::OnDragTarget(const DragTargetMsg& aMsg) {
  Entry* entry = FindEntry(aMsg.windowId);
  if (!entry) {
    return;
  }
  ChildView* view =
      (ChildView*)entry->mWindow->GetNativeData(NS_NATIVE_WIDGET);
  NSWindow* window = (NSWindow*)entry->mWindow->GetNativeData(NS_NATIVE_WINDOW);
  if (!view || !window) {
    return;
  }
  [[view retain] autorelease];
  const uint32_t windowId = entry->mId;
  NSSize size = [window contentRectForFrameRect:window.frame].size;
  NSPoint location = NSMakePoint(aMsg.x, size.height - aMsg.y);
  NSEvent* event = [NSEvent
      mouseEventWithType:aMsg.phase == kDragDrop ? NSEventTypeLeftMouseUp
                                                 : NSEventTypeLeftMouseDragged
                location:location
           modifierFlags:NSEventModifierFlags(aMsg.modifiers)
               timestamp:NSProcessInfo.processInfo.systemUptime
            windowNumber:window.windowNumber
                 context:nil
             eventNumber:0
              clickCount:aMsg.phase == kDragDrop ? 1 : 0
                pressure:aMsg.phase == kDragDrop ? 0.0 : 1.0];
  NSDragOperation operation = NSDragOperationNone;
  if (!mTargetInfo || mTargetWindow != windowId || aMsg.phase == kDragEnter) {
    if (aMsg.phase == kDragExit) {
      return;
    }
    // A drag comes over the window (an exit from another may have been lost).
    // Its data is on the system's drag pasteboard, as AppKit's would be.
    [mTargetInfo release];
    mTargetInfo = [[ZenEmbedDragInfo alloc]
        initWithWindow:window
            pasteboard:[NSPasteboard pasteboardWithName:NSPasteboardNameDrag]
                source:mDrag && mDrag->mWindowId == windowId ? mDrag->mView
                                                             : nil
            operations:NSDragOperation(aMsg.operations)
              sequence:++mDragSequence];
    mTargetWindow = windowId;
    ZenEmbedDragInfo* info = [[mTargetInfo retain] autorelease];
    [info moveTo:location event:event];
    operation = [view draggingEntered:info];
    mTargetOperation = operation;
    if (aMsg.phase == kDragEnter) {
      SendDragStatus(windowId, operation, 0);
      return;
    }
  }
  ZenEmbedDragInfo* info = [[mTargetInfo retain] autorelease];
  [info moveTo:location event:event];
  if (aMsg.phase == kDragOver) {
    operation = [view draggingUpdated:info];
    if (info == mTargetInfo) {
      mTargetOperation = operation;
    }
    SendDragStatus(windowId, operation, 0);
    return;
  }
  // An exit or a drop: this drag is over here.
  NSDragOperation accepted = info == mTargetInfo ? mTargetOperation
                                                 : NSDragOperationNone;
  if (info == mTargetInfo) {
    [mTargetInfo release];
    mTargetInfo = nil;
    mTargetWindow = 0;
  }
  if (aMsg.phase == kDragDrop && accepted != NSDragOperationNone) {
    operation = [view performDragOperation:info] ? accepted
                                                 : NSDragOperationNone;
  } else {
    [view draggingExited:info];
  }
  SendDragStatus(windowId, operation, 0);
}

void Channel::SendDragStarted(const Entry& aEntry, NSDraggingItem* aItem,
                              NSPoint aPointer, NSString* aPasteboard) {
  if (!mAuthenticated) {
    return;
  }
  // The drag image, as AppKit would show it: its frame is in the view's
  // (flipped) coordinates, the window's points from its top left.
  NSRect frame = aItem.draggingFrame;
  NSImage* image = nil;
  for (NSDraggingImageComponent* component in aItem.imageComponents) {
    if ([component.contents isKindOfClass:[NSImage class]]) {
      image = component.contents;
      break;
    }
  }
  NSData* png = nil;
  const CGFloat scale = aEntry.mWindow->BackingScaleFactor();
  if (image && frame.size.width >= 1 && frame.size.height >= 1) {
    NSBitmapImageRep* rep = [[[NSBitmapImageRep alloc]
        initWithBitmapDataPlanes:nullptr
                      pixelsWide:NSInteger(std::ceil(frame.size.width * scale))
                      pixelsHigh:NSInteger(std::ceil(frame.size.height * scale))
                   bitsPerSample:8
                 samplesPerPixel:4
                        hasAlpha:YES
                        isPlanar:NO
                  colorSpaceName:NSDeviceRGBColorSpace
                     bytesPerRow:0
                    bitsPerPixel:0] autorelease];
    rep.size = frame.size;
    [NSGraphicsContext saveGraphicsState];
    NSGraphicsContext.currentContext =
        [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
    [image drawInRect:NSMakeRect(0, 0, frame.size.width, frame.size.height)];
    [NSGraphicsContext restoreGraphicsState];
    png = [rep representationUsingType:NSBitmapImageFileTypePNG
                            properties:@{}];
  }
  // Out of line, in pages of its own (as SendOutOfLine).
  vm_address_t address = 0;
  const uint32_t length = uint32_t(png.length);
  if (length > 0) {
    if (vm_allocate(mach_task_self(), &address, length, VM_FLAGS_ANYWHERE) !=
        KERN_SUCCESS) {
      return;
    }
    memcpy(reinterpret_cast<void*>(address), png.bytes, length);
  }
  DragStartedMsg msg{};
  msg.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0,
                                            MACH_MSGH_BITS_COMPLEX);
  msg.header.msgh_id = kMsgDragStarted;
  msg.body.msgh_descriptor_count = 1;
  msg.image.address = reinterpret_cast<void*>(address);
  msg.image.size = length;
  msg.image.deallocate = length > 0;
  msg.image.copy = MACH_MSG_VIRTUAL_COPY;
  msg.image.type = MACH_MSG_OOL_DESCRIPTOR;
  msg.windowId = aEntry.mId;
  msg.imageLength = length;
  msg.imageX = frame.origin.x;
  msg.imageY = frame.origin.y;
  msg.imageWidth = frame.size.width;
  msg.imageHeight = frame.size.height;
  msg.pointerX = aPointer.x;
  msg.pointerY = aPointer.y;
  msg.operations = NSDragOperationEvery;
  const char* name = aPasteboard.UTF8String;
  msg.pasteboardLength =
      uint32_t(std::min(strlen(name), sizeof(msg.pasteboard)));
  memcpy(msg.pasteboard, name, msg.pasteboardLength);
  if (!Send(&msg.header, sizeof(msg), 2000)) {
    EMBED_LOG("drag of window %u could not be announced", aEntry.mId);
  }
}

void Channel::SendDragStatus(uint32_t aWindowId, NSDragOperation aOperation,
                             uint32_t aFlags) {
  if (!mAuthenticated) {
    return;
  }
  DragStatusMsg msg{};
  msg.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, 0);
  msg.header.msgh_id = kMsgDragStatus;
  msg.windowId = aWindowId;
  msg.flags = aFlags;
  msg.operation = aOperation;
  Send(&msg.header, sizeof(msg));
}

}  // namespace

bool ZenEmbedHost::IsEnabled() {
  static const bool sEnabled = [] {
    const char* service = getenv("NIGHTLY_EMBED_SERVICE");
    return service && *service && XRE_IsParentProcess();
  }();
  return sEnabled;
}

bool ZenEmbedHost::ShouldEmbedNewWindow() {
  return sEmbedNextWindow && IsEnabled();
}

const char* ZenEmbedHost::EmbedDocument() { return kEmbedDocument; }

bool ZenEmbedHost::IsEmbedDocumentWindow(nsIWidget* aWidget) {
  return aWidget && sChannel && sChannel->IsEmbedDocumentWindow(aWidget);
}

void ZenEmbedHost::CursorChanged(nsCocoaWindow* aWindow, int aCursor) {
  if (sChannel) {
    sChannel->CursorChanged(aWindow, uint32_t(aCursor));
  }
}

bool ZenEmbedHost::BeginDrag(NSView* aView, NSArray<NSDraggingItem*>* aItems) {
  return sChannel && sChannel->BeginDrag(aView, aItems);
}

ZenEmbedHost::AutoEmbedScope::AutoEmbedScope(nsIURI* aUrl)
    : mPrevious(sEmbedNextWindow) {
  bool embed = false;
  if (aUrl && IsEnabled()) {
    nsAutoCString spec;
    // Without the query: the embed document carries ?pane=<token>.
    if (NS_SUCCEEDED(aUrl->GetSpecIgnoringRef(spec))) {
      nsAutoCString withQuery(kEmbedDocument);
      withQuery.Append('?');
      static bool sCommandLineBrowserSeen = false;
      if (!sCommandLineBrowserSeen && spec.Equals(kBrowserDocument)) {
        // The process's first browser window: the command line's (-chrome
        // browser.xhtml) when the embedder's first pane is a browser window,
        // NIGHTLY_EMBED_BROWSER_PANE naming that pane.
        sCommandLineBrowserSeen = true;
        const char* pane = getenv("NIGHTLY_EMBED_BROWSER_PANE");
        if (pane && *pane && !sBrowserPaneForNextWindow) {
          sBrowserPaneForNextWindow = uint32_t(strtoul(pane, nullptr, 10));
        }
      }
      const bool browser = spec.Equals(kBrowserDocument);
      // Any other browser window while a pane shows one (a page's popup, a
      // new window, a moved tab's, a restored one, an external link's) would
      // be a Nightly window of its own on screen beside the embedder: it is
      // embedded too and stays off screen as a stray, whose tabs
      // ZenEmbedBrowser.sys.mjs moves into the pane's window.
      sStrayNextWindow = browser && !sBrowserPaneForNextWindow && sChannel &&
                         sChannel->HasBrowserWindow();
      embed = spec.Equals(kEmbedDocument) || StringBeginsWith(spec, withQuery) ||
              // The browser window OnOpenBrowserWindow opens for a pane.
              (sBrowserPaneForNextWindow && browser) || sStrayNextWindow;
    }
  }
  sEmbedNextWindow = embed;
}

ZenEmbedHost::AutoEmbedScope::~AutoEmbedScope() {
  sEmbedNextWindow = mPrevious;
  sStrayNextWindow = false;
}

void ZenEmbedHost::WindowCreated(nsCocoaWindow* aWindow,
                                 NativeLayerRootCA* aLayerRoot) {
  if (Channel* channel = Channel::GetOrCreate()) {
    channel->AddWindow(aWindow, aLayerRoot);
  }
}

void ZenEmbedHost::WindowVisibilityChanged(nsCocoaWindow* aWindow,
                                           bool aVisible) {
  if (sChannel) {
    sChannel->SetWindowVisible(aWindow, aVisible);
  }
}

void ZenEmbedHost::WindowDestroyed(nsCocoaWindow* aWindow) {
  if (sChannel) {
    sChannel->RemoveWindow(aWindow);
  }
}

}  // namespace zen
