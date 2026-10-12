#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Rebrand user-visible Zen Browser strings to Nightly Browser (idempotent).

Run after every upstream (Zen) sync:  python3 scripts/nightly_rebrand.py
`--root DIR` rebrands another checkout (default: this repo). Only files under
the root are touched; a second run changes nothing. Stdlib only.

What is rewritten
- Fluent (.ftl), .properties and .dtd files under locales/ and src/, and the
  added ("+") lines of src/**/*.patch files that patch such files: message
  values and attributes only. Message IDs, comments and `{ placeables }` are
  never touched, so `zen-*` IDs, `zen.*` prefs, `gZen*` globals, CSS classes,
  URLs and code stay as in Zen and upstream changes keep applying.
- A fixed list of packaging files (PACKAGING below): app name/profile
  directory/vendor defaults in src/toolkit/moz-configure.patch, the AppImage
  desktop entry and launcher, and the Flatpak manifest template. Files whose
  name carries the Zen id are moved to the Nightly name.

Naming decisions
- "Zen Browser" -> "Nightly Browser"; "Zen Twilight" -> "Nightly Browser Beta".
- Standalone "Zen" used as the product name -> "Nightly", feature names
  included: "Zen Mods" -> "Nightly Mods", "Zen URL Bar" -> "Nightly URL Bar",
  "Zen Web Panels", "Zen Library", built-in themes "Zen Galaxy"/"Zen Dream"
  -> "Nightly Galaxy"/"Nightly Dream".
- Literal "Nightly" rather than `{ -brand-short-name }`: not every Zen .ftl is
  loaded next to brand.ftl, and on the beta channel the term expands to
  "Nightly Beta", which must not leak into feature names ("Nightly Beta Mods").
- Inflections: hyphenated compounds keep the hyphen ("Zen-Mods" ->
  "Nightly-Mods", ro "Zen-ul" -> "Nightly-ul", hu "Zen-ben" -> "Nightly-ben");
  forms glued to the stem are mapped explicitly (fi "Zenin" -> "Nightlyn",
  cs "Zenu" -> "Nightly", et "Zeni"/"Zen-i" -> "Nightly", tr "Zen'e" ->
  "Nightly'ye"); Korean particles follow the vowel ending ("Zen이" -> "Nightly가").
- "Zen´s Team" (uninstall survey label) -> "the Nightly Browser team".
- Lowercase "zen" is always an identifier/URL and is left alone; URLs are not
  rewritten here.
"""

import argparse
import os
import re
import sys

# Ordered: specific phrases and inflections before the generic product word.
_TEXT_RULES = [
    (re.compile(r"Zen Browser"), "Nightly Browser"),
    (re.compile(r"Zen Twilight"), "Nightly Browser Beta"),
    (re.compile(r"Zen[´'’]s Team"), "the Nightly Browser team"),
    (re.compile(r"\bZenin\b"), "Nightlyn"),
    (re.compile(r"\bZenu\b"), "Nightly"),
    (re.compile(r"\bZen-?i\b"), "Nightly"),
    (re.compile(r"\bZen'e\b"), "Nightly'ye"),
    # ko: "Zen" ends in a consonant, "Nightly" in a vowel; swap the particle.
    (re.compile(r"Zen이(?=\s)"), "Nightly가"),
    (re.compile(r"Zen은(?=\s)"), "Nightly는"),
    (re.compile(r"Zen을(?=\s)"), "Nightly를"),
    (re.compile(r"Zen과(?=\s)"), "Nightly와"),
    (re.compile(r"Zen으로(?=\s)"), "Nightly로"),
    # "Zen" as a word: not part of an identifier/path/URL (ZenMods, zen.*,
    # /Zen, $Zen) and not touching a Latin letter or digit. CJK, Arabic
    # prefixes, quotes, apostrophes and hyphens may touch it ("Zenは", "لZen",
    # "„Zen“", "Zen's", "Zen-Mods").
    (re.compile(r"(?<![0-9A-Za-z_\u00C0-\u024F.\-/:@#$])Zen(?![0-9A-Za-z_\u00C0-\u024F])"),
     "Nightly"),
]

_PLACEABLE = re.compile(r"(\{[^{}]*\})")


def rebrand_text(text):
  """Rebrand free text, leaving `{ placeables }` untouched."""
  parts = _PLACEABLE.split(text)
  for i in range(0, len(parts), 2):  # even indexes are text, odd are placeables
    for pattern, repl in _TEXT_RULES:
      parts[i] = pattern.sub(repl, parts[i])
  return "".join(parts)


_FTL_MESSAGE = re.compile(r"^(-?[A-Za-z][\w-]*[ \t]*=)(.*)$")
_FTL_ATTRIBUTE = re.compile(r"^([ \t]+\.[A-Za-z][\w-]*[ \t]*=)(.*)$")
_FTL_VARIANT = re.compile(r"^([ \t]+\*?\[[^\]]*\])(.*)$")


def rebrand_ftl_line(line):
  if not line.strip() or line.lstrip().startswith("#"):
    return line
  for pattern in (_FTL_MESSAGE, _FTL_ATTRIBUTE, _FTL_VARIANT):
    m = pattern.match(line)
    if m:
      return m.group(1) + rebrand_text(m.group(2))
  if line[0] in " \t":  # continuation of a multiline value
    return rebrand_text(line)
  return line


_PROPERTIES = re.compile(r"^([ \t]*[^#!\s][^=:]*?[ \t]*[=:])(.*)$")


def rebrand_properties_line(line):
  m = _PROPERTIES.match(line)
  return m.group(1) + rebrand_text(m.group(2)) if m else line


_DTD_ENTITY = re.compile(r'(<!ENTITY\s+[\w.\-]+\s+)(["\'])(.*?)(\2)')


def rebrand_dtd_line(line):
  return _DTD_ENTITY.sub(lambda m: m.group(1) + m.group(2) + rebrand_text(m.group(3)) + m.group(4),
                         line)


LINE_REBRANDERS = {
    ".ftl": rebrand_ftl_line,
    ".properties": rebrand_properties_line,
    ".dtd": rebrand_dtd_line,
}


def rebrand_lines(text, rebrand_line):
  return "".join(rebrand_line(line[:-1]) + "\n" if line.endswith("\n") else rebrand_line(line)
                 for line in text.splitlines(keepends=True))


def rebrand_patch(text):
  """Rebrand the added lines of hunks that patch localization files."""
  out, rebrand_line = [], None
  for line in text.splitlines(keepends=True):
    if line.startswith("+++ "):
      target = line[4:].strip()
      rebrand_line = LINE_REBRANDERS.get(os.path.splitext(target)[1])
    elif line.startswith("diff --git "):
      rebrand_line = None
    elif rebrand_line and line.startswith("+"):
      body, nl = (line[1:-1], "\n") if line.endswith("\n") else (line[1:], "")
      line = "+" + rebrand_line(body) + nl
    out.append(line)
  return "".join(out)


# Packaging: (old path, new path, [(old substring, new substring), ...]).
# old path == new path means rewrite in place; otherwise the file is moved.
PACKAGING = [
    ("src/toolkit/moz-configure.patch", "src/toolkit/moz-configure.patch", [
        ('+    default="Zen Team",', '+    default="Nightly Browser",'),        # MOZ_APP_VENDOR
        ('+    default="zen",', '+    default="nightly",'),                     # MOZ_APP_PROFILE
        ('+        return "zen"', '+        return "nightly"'),                 # ~/.nightly user appdir
        ('+    default="app.zen-browser",', '+    default="io.github.samnolak",'),  # distribution id
    ]),
    ("build/AppDir/zen.desktop", "build/AppDir/nightly.desktop", [
        ("Name=Zen Browser\n", "Name=Nightly Browser\n"),
        ("Exec=zen ", "Exec=nightly "),
        ("Icon=zen\n", "Icon=nightly\n"),
        ("StartupWMClass=zen\n", "StartupWMClass=nightly\n"),
    ]),
    ("build/AppDir/AppRun", "build/AppDir/AppRun", [
        ('exec "${CURRENTDIR}/zen" "$@"', 'exec "${CURRENTDIR}/nightly" "$@"'),
    ]),
    ("build/flatpak/app.zen_browser.zen.yml.template",
     "build/flatpak/io.github.samnolak.nightly.yml.template", [
         ("app.zen_browser.zen", "io.github.samnolak.nightly"),
         ("directory: etc/zen\n", "directory: etc/nightly\n"),
         ("--persist=.zen\n", "--persist=.nightly\n"),
         ("--own-name=org.mozilla.zen.*", "--own-name=org.mozilla.nightly.*"),
         ("- name: zen_browser\n", "- name: nightly_browser\n"),
         ("mv zen /app/", "mv nightly /app/"),
         ("mkdir -p /app/etc/zen\n", "mkdir -p /app/etc/nightly\n"),
         ("https://github.com/zen-browser/desktop/releases/download/{version}/zen.linux-",
          "https://github.com/samnolak/nightly-browser/releases/download/{version}/nightly.linux-"),
         ("https://github.com/zen-browser/flatpak/releases/download/{version}/archive.tar",
          "https://github.com/samnolak/nightly-browser/releases/download/{version}/flatpak-metadata.tar"),
     ]),
]

SCAN_DIRS = ("locales", "src")
SKIP_DIRS = {".git", "node_modules", "engine", "tests"}


def read(path):
  with open(path, encoding="utf-8", newline="") as f:
    return f.read()


def write(path, text):
  with open(path, "w", encoding="utf-8", newline="") as f:
    f.write(text)


def iter_l10n_files(root):
  for top in SCAN_DIRS:
    for dirpath, dirnames, filenames in os.walk(os.path.join(root, top)):
      dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
      for name in sorted(filenames):
        ext = os.path.splitext(name)[1]
        if ext in LINE_REBRANDERS or ext == ".patch":
          yield os.path.join(dirpath, name), ext


def rebrand_l10n(root):
  changed = []
  for path, ext in iter_l10n_files(root):
    text = read(path)
    if "Zen" not in text:
      continue
    new = rebrand_patch(text) if ext == ".patch" else rebrand_lines(text, LINE_REBRANDERS[ext])
    if new != text:
      write(path, new)
      changed.append(path)
  return changed


def rebrand_packaging(root):
  changed = []
  for old_rel, new_rel, rules in PACKAGING:
    old, new = os.path.join(root, old_rel), os.path.join(root, new_rel)
    source = old if os.path.exists(old) else new
    if not os.path.exists(source):
      continue
    text = read(source)
    result = text
    for before, after in rules:
      result = result.replace(before, after)
    if source != new or result != text:
      write(new, result)
      if source != new:
        os.chmod(new, os.stat(source).st_mode & 0o777)
        os.remove(source)
      changed.append(new)
  return changed


def main():
  default_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
  parser = argparse.ArgumentParser(description="Rebrand Zen Browser strings to Nightly Browser.")
  parser.add_argument("--root", default=default_root, help="checkout to rebrand (default: this repo)")
  args = parser.parse_args()
  root = os.path.abspath(args.root)
  if not os.path.isdir(root):
    sys.exit(f"--root {root} is not a directory")
  changed = rebrand_l10n(root) + rebrand_packaging(root)
  for path in changed:
    print(f"rebranded {os.path.relpath(path, root)}")
  print(f"{len(changed)} file(s) changed")


if __name__ == "__main__":
  main()
