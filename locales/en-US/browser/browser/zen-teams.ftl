# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Sharing with the team through Ombra (B1, B2)

zen-team-share-page =
    .label = Share Page with Team…
zen-team-share-tab =
    .label = Share Tab with Team…
zen-team-share-group =
    .label = Share Tab Group with Team…

# $reason: why Ombra cannot share now
zen-team-unavailable =
    .label =
        { $reason ->
            [untrusted] Can’t share: the Ombra on this Mac could not be verified
            [signed-out] Can’t share: sign in to your team in Ombra
            [no-team] Can’t share: create or join a team in Ombra
            [not-ready] Can’t share: Ombra is still loading your team
            [no-members] Can’t share: nobody else is in your team yet
           *[other] Can’t share: open Ombra on this Mac
        }
zen-team-unavailable-toast =
    { $reason ->
        [untrusted] The Ombra on this Mac could not be verified
        [signed-out] Sign in to your team in Ombra to share
        [no-team] Create or join a team in Ombra to share
        [not-ready] Ombra is still loading your team
        [no-members] Nobody else is in your team yet
       *[other] Open Ombra on this Mac to share with your team
    }

zen-team-share-dialog =
    .title = Share with Team
    .buttonlabelaccept = Send
zen-team-share-title = Share with Team
zen-team-share-what-link = Page: { $title }
zen-team-share-what-screenshot = Screenshot: { $title }
zen-team-share-what-collection =
    { $count ->
        [one] Tab group “{ $title }”, 1 tab
       *[other] Tab group “{ $title }”, { $count } tabs
    }
# $names: the parameter names, comma separated
zen-team-share-secrets = The address looks like it contains a secret ({ $names }). Anyone you send it to could use it.
zen-team-share-strip = Remove these parameters before sending
zen-team-share-comment =
    .placeholder = Comment (optional)
zen-team-share-team = Team
zen-team-share-to = Send to
zen-team-share-to-all =
    { $count ->
        [one] Everyone in the team (1 member)
       *[other] Everyone in the team ({ $count } members)
    }
zen-team-share-to-members = Selected members
zen-team-share-sending = Sending through Ombra…
# $reason: an error code from Ombra; $detail: its explanation
zen-team-share-failed =
    { $reason ->
        [not-running] Ombra stopped answering. Open Ombra and try again.
        [untrusted] The Ombra on this Mac could not be verified.
        [timeout] Ombra did not answer in time. Try again.
        [too-large] This is too large to share.
       *[other] Could not share: { $detail }
    }

zen-team-shared =
    { $count ->
        [one] Shared with 1 member
       *[other] Shared with { $count } members
    }

## Toasts for what team members shared. $author: who shared; $title: what

zen-team-incoming-link = { $author } shared a link “{ $title }”
zen-team-incoming-collection = { $author } shared a collection “{ $title }”
zen-team-incoming-screenshot = { $author } shared a snapshot “{ $title }”
zen-team-toast-open =
    .label = Open
zen-team-open-failed = Could not open it. Is Ombra running?
