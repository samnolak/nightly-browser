# Personal data is under NDA

The owner's personal data and anything about the machine this is developed on are confidential (NDA). None of it
may appear in this repository — files, commit messages, author/committer names and emails, branch and tag names,
test fixtures, screenshots, release notes, release assets — nor in issues, PRs, CI logs or anything published:

- the owner's real name, the macOS user name and home path (write `$HOME`, `~` or `/Users/me`), the computer's host
  name and network domain, local IP addresses, serial numbers;
- the employer, its products, internal hosts and services, and names of the owner's work projects or repositories
  (use `example`, `myproject`, `example.com`);
- what the owner keeps in their apps: browser profiles and their ids, spaces, tabs, bookmarks, history, chats,
  account names;
- keys, certificates, passwords and tokens (they live in the repository secrets and the owner's keychain only).

Commits are authored as `samnolak <258669251+samnolak@users.noreply.github.com>`. Release builds (DMG, MAR, the
runtime archive for Ombra) embed their source and object paths: build them from a checkout under a path without the
user name (`/Users/Shared/…`), never from the home folder, and check the packed files for private terms before
publishing. A local pre-commit hook rejects commits that contain the owner's private terms (the list stays outside
the repository); never bypass it with `--no-verify`. If something slips through, it is removed from the whole
history, not just from the next commit.
