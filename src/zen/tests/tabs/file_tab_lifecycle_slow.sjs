/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Answers after a short delay so several queued tabs are loading at once.
function handleRequest(request, response) {
  response.processAsync();
  response.setHeader("Content-Type", "text/html", false);
  const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timer.initWithCallback(
    () => {
      response.write(`<title>${request.queryString}</title>slow`);
      response.finish();
    },
    300,
    Ci.nsITimer.TYPE_ONE_SHOT
  );
}
