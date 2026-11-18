#!/usr/bin/env python3
"""Mask credentials that ended up in r-docs' stored data.

Until 2026-11 an agent's `git push` printed the user's GitHub token (it was
part of the remote URL), and the run log kept the output. New runs no longer
hold the token and new events are masked before they are stored
(lib/secret-redaction.ts). This script cleans what was stored before that.

It looks at:
  1. the database: every text column of every table;
  2. conversation transcripts on disk (<workspaces>/<doc>/sessions/**);
  3. git config files of checkouts (<workspaces>/<doc>/<repo>/.git/config and
     <workspaces>/<doc>/worktrees/*/.git/config), where older versions pinned
     the token;
  4. per-run scratch directories and the service logs;
  5. database backups (raw files).

DRY RUN BY DEFAULT: nothing is written, the database is opened read-only and
immutable (no -wal/-shm files appear). Pass --apply to change things.

It never prints a secret: only counts, locations and how many DISTINCT secrets
of each kind were seen.

A masked value keeps its length and a short prefix; the rest becomes `*`
(e.g. ghp_****...). Because the length does not change, files are masked in
place, which is safe for a log another process is appending to.

Columns that are credential STORES (named like token/secret/key/hash, or in a
credential table) are reported but never changed: masking them would break
logins, and they are encrypted or hashed anyway.

Usage, from the r-docs directory:
  python3 scripts/redact-stored-secrets.py                 # dry run, everything
  python3 scripts/redact-stored-secrets.py --only db       # one area: db, sessions, git-config, scratch, logs, backups
  python3 scripts/redact-stored-secrets.py --apply         # do it
After --apply on the database, old row contents can survive in free pages; the
script zeroes them (secure_delete) and then re-scans the raw file to prove it.
"""
import argparse
import collections
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

with open(os.path.join(ROOT, "lib", "secret-shapes.json"), encoding="utf-8") as fh:
    _SHAPES = json.load(fh)

SHAPES = [
    (shape["name"], re.compile(_SHAPES["boundary"] + shape["pattern"]), shape["prefix"])
    for shape in _SHAPES["shapes"]
]
PRIVATE_KEY_NAME = _SHAPES["privateKey"]["name"]
PRIVATE_KEY = re.compile(_SHAPES["privateKey"]["pattern"])
_KEY_BODY_PIECE = re.compile(r"\\+[rn]|[A-Za-z0-9+/=]")
# Cheap test before the regular expressions run.
HINTS = ("gh", "eC1hY2Nlc3MtdG9rZW46", "sk-", "hf_", "xox", "AIza", "rpa_", "gdai_", "tml-", "PRIVATE KEY-----")

CREDENTIAL_COLUMN = re.compile(r"token|secret|password|passwd|credential|hash|apikey|api_key|privatekey|authjson", re.I)
CREDENTIAL_TABLE = re.compile(r"credential|installation|apikey|brokerkey|envvar|oauth|account$|^session$|verification", re.I)


class Tally:
    """Counts per kind, and distinct secrets per kind (by hash, never the value)."""

    def __init__(self):
        self.count = collections.Counter()
        self.distinct = collections.defaultdict(set)

    def add(self, kind, value):
        self.count[kind] += 1
        self.distinct[kind].add(hashlib.sha256(value.encode("utf-8", "replace")).digest()[:8])

    def merge(self, other):
        self.count.update(other.count)
        for kind, values in other.distinct.items():
            self.distinct[kind] |= values

    def __bool__(self):
        return bool(self.count)

    def describe(self):
        return ", ".join(
            f"{count} x {kind} ({len(self.distinct[kind])} distinct)" for kind, count in sorted(self.count.items())
        )


def redact(text, tally=None, owned_end=None):
    """Length-preserving masking; mirrors redactSecrets in lib/secret-redaction.ts.

    With owned_end, only matches that START before that offset are masked and
    counted (the rest belong to the next chunk of a file read in pieces).
    """
    if not any(hint in text for hint in HINTS):
        return text
    for name, regex, prefix in SHAPES:
        def mask(match, name=name, prefix=prefix):
            value = match.group(0)
            if owned_end is not None and match.start() >= owned_end:
                return value
            if tally is not None:
                tally.add(name, value)
            return value[:prefix] + "*" * max(0, len(value) - prefix)
        text = regex.sub(mask, text)

    def mask_key(match):
        if owned_end is not None and match.start() >= owned_end:
            return match.group(0)
        body = match.group(2)
        masked = _KEY_BODY_PIECE.sub(lambda piece: piece.group(0) if piece.group(0).startswith("\\") else "*", body)
        if masked != body and tally is not None:
            tally.add(PRIVATE_KEY_NAME, body)
        return match.group(1) + masked
    return PRIVATE_KEY.sub(mask_key, text)


# --- database -------------------------------------------------------------------

def is_credential_store(table, column):
    return bool(CREDENTIAL_TABLE.search(table) or CREDENTIAL_COLUMN.search(column))


def clean_database(path, apply):
    print(f"\n== database {path}")
    if not os.path.exists(path):
        print("   not found, skipped")
        return Tally()
    if apply:
        db = sqlite3.connect(path, timeout=120)
        db.execute("PRAGMA secure_delete=ON")
    else:
        db = sqlite3.connect(f"file:{path}?immutable=1", uri=True)
    total = Tally()
    tables = [r[0] for r in db.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
    for table in tables:
        columns = [(c[1], (c[2] or "").upper()) for c in db.execute(f'pragma table_info("{table}")')]
        text_columns = [name for name, kind in columns if kind in ("TEXT", "", "JSON", "JSONB", "BLOB") or "CHAR" in kind]
        if not text_columns:
            continue
        select = ", ".join(f'"{c}"' for c in text_columns)
        updates = []
        per_column = collections.defaultdict(Tally)
        try:
            rows = db.execute(f'select rowid, {select} from "{table}"')
        except sqlite3.OperationalError:
            continue  # WITHOUT ROWID or virtual table: none hold run output
        for row in rows:
            changes = {}
            for column, value in zip(text_columns, row[1:]):
                if not isinstance(value, str):
                    continue
                tally = Tally()
                masked = redact(value, tally)
                if masked != value:
                    per_column[column].merge(tally)
                    if not is_credential_store(table, column):
                        changes[column] = masked
            if changes:
                updates.append((row[0], changes))
        for column, tally in per_column.items():
            kept = is_credential_store(table, column)
            total.merge(tally) if not kept else None
            note = "LEFT ALONE (credential store)" if kept else ("masked" if apply else "would be masked")
            print(f"   {table}.{column}: {tally.describe()} -> {note}")
        if apply and updates:
            with db:
                for rowid, changes in updates:
                    assignments = ", ".join(f'"{c}" = ?' for c in changes)
                    db.execute(f'update "{table}" set {assignments} where rowid = ?', [*changes.values(), rowid])
            print(f"   {table}: {len(updates)} rows updated")
    if apply:
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    db.close()
    if not total:
        print("   nothing to mask outside credential stores")
    if apply:
        # Old cell contents can linger in free pages or the WAL. Prove they do not.
        left = Tally()
        for candidate in (path, path + "-wal"):
            if os.path.exists(candidate):
                left.merge(scan_file(candidate, apply=False))
        print("   raw re-scan of the database file after masking: "
              + (left.describe() + "  <- includes the credential stores left alone above; if this is more than those,"
                 " run `sqlite3 <db> VACUUM` with the service stopped" if left else "clean"))
    return total


# --- files ----------------------------------------------------------------------

CHUNK = 8 << 20
OVERLAP = 64 << 10


def scan_file(path, apply):
    """Mask (or, in a dry run, count) secrets in one file, in place, any size."""
    tally = Tally()
    try:
        fh = open(path, "r+b" if apply else "rb")
    except OSError:
        return tally
    with fh:
        size = os.fstat(fh.fileno()).st_size
        position = 0
        while position < size:
            fh.seek(position)
            data = fh.read(CHUNK + OVERLAP)
            if not data:
                break
            last = position + len(data) >= size
            text = data.decode("latin1")  # one byte = one character: offsets carry over
            # A secret that starts in the overlap is complete in the next chunk and is handled there.
            masked = redact(text, tally, None if last else CHUNK)
            if apply and masked != text:
                start = 0
                while start < len(text):
                    if text[start] == masked[start]:
                        start += 1
                        continue
                    end = start
                    while end < len(text) and text[end] != masked[end]:
                        end += 1
                    fh.seek(position + start)
                    fh.write(masked[start:end].encode("latin1"))
                    start = end
            if last:
                break
            position += CHUNK
    return tally


def clean_tree(label, root, apply, wanted=None, max_bytes=None):
    print(f"\n== {label} {root}")
    if not os.path.isdir(root):
        print("   not found, skipped")
        return Tally()
    total = Tally()
    files = hits = unreadable = 0
    for directory, subdirs, names in os.walk(root, followlinks=False):
        for name in names:
            path = os.path.join(directory, name)
            if os.path.islink(path) or not os.path.isfile(path):
                continue
            if wanted and not wanted(path):
                continue
            if max_bytes and os.path.getsize(path) > max_bytes:
                continue
            if apply and not os.access(path, os.W_OK):
                unreadable += 1
                continue
            files += 1
            tally = scan_file(path, apply)
            if tally:
                hits += 1
                total.merge(tally)
    verb = "masked" if apply else "would be masked"
    print(f"   {files} files looked at, {hits} with secrets" + (f": {total.describe()} -> {verb}" if total else ""))
    if unreadable:
        print(f"   {unreadable} files are not writable by this user and were skipped (run as their owner)")
    return total


def clean_sessions(workspaces, apply):
    """Transcripts live in <workspaces>/<doc>/sessions; the rest of a workspace is the user's files."""
    print(f"\n== conversation transcripts under {workspaces}/*/sessions")
    if not os.path.isdir(workspaces):
        print("   not found, skipped")
        return
    total, files, hits, skipped = Tally(), 0, 0, 0
    for document in sorted(os.listdir(workspaces)):
        root = os.path.join(workspaces, document, "sessions")
        if not os.path.isdir(root) or os.path.islink(root):
            continue
        for directory, _subdirs, names in os.walk(root, followlinks=False):
            for name in names:
                path = os.path.join(directory, name)
                if os.path.islink(path) or not os.path.isfile(path):
                    continue
                if apply and not os.access(path, os.W_OK):
                    skipped += 1
                    continue
                files += 1
                tally = scan_file(path, apply)
                if tally:
                    hits += 1
                    total.merge(tally)
    verb = "masked" if apply else "would be masked"
    print(f"   {files} files looked at, {hits} with secrets" + (f": {total.describe()} -> {verb}" if total else ""))
    if skipped:
        print(f"   {skipped} files are not writable by this user and were skipped (run as their owner)")


# --- git config files of checkouts ----------------------------------------------

GIT_SECTION = re.compile(r"^\s*\[")
TOKEN_URL_SECTION = re.compile(r'^\s*\[url\s+"[^"]*x-access-token:[^"@]+@', re.I)
EXTRAHEADER_LINE = re.compile(r"^\s*extraheader\s*=\s*authorization:\s*basic\s", re.I)
URL_WITH_USERINFO = re.compile(r"(https?://)[^/\s@:]+:[^/\s@]+@")


def clean_git_config(path, apply):
    """Drop pinned GitHub credentials from one git config. Returns how many entries."""
    try:
        with open(path, encoding="utf-8", errors="surrogateescape") as fh:
            lines = fh.readlines()
    except OSError:
        return 0
    out, removed, skipping = [], 0, False
    for line in lines:
        if GIT_SECTION.match(line):
            skipping = bool(TOKEN_URL_SECTION.match(line))
            if skipping:
                removed += 1
                continue
        if skipping:
            continue
        if EXTRAHEADER_LINE.match(line):
            removed += 1
            continue
        stripped, replaced = URL_WITH_USERINFO.subn(r"\1", line)
        if replaced and "url" in line.split("=")[0]:
            removed += 1
            line = stripped
        out.append(line)
    if removed and apply:
        mode = os.stat(path).st_mode & 0o777
        fd, temp = tempfile.mkstemp(dir=os.path.dirname(path), prefix="config.redact-")
        with os.fdopen(fd, "w", encoding="utf-8", errors="surrogateescape") as fh:
            fh.writelines(out)
        os.chmod(temp, mode)
        os.replace(temp, path)
    return removed


def clean_git_configs(workspaces, apply):
    print(f"\n== git config of checkouts under {workspaces}")
    if not os.path.isdir(workspaces):
        print("   not found, skipped")
        return 0
    configs = []
    for document in sorted(os.listdir(workspaces)):
        base = os.path.join(workspaces, document)
        if not os.path.isdir(base):
            continue
        candidates = [os.path.join(base, name) for name in os.listdir(base) if name not in ("worktrees", "sessions")]
        worktrees = os.path.join(base, "worktrees")
        if os.path.isdir(worktrees):
            candidates += [os.path.join(worktrees, name) for name in os.listdir(worktrees)]
        for checkout in candidates:
            config = os.path.join(checkout, ".git", "config")
            if os.path.isfile(config) and not os.path.islink(config):
                configs.append(config)
    entries = files = 0
    for config in configs:
        removed = clean_git_config(config, apply)
        if removed:
            files += 1
            entries += removed
    verb = "removed" if apply else "would be removed"
    print(f"   {len(configs)} config files looked at, {files} hold a pinned credential ({entries} entries) -> {verb}")
    if files and not apply:
        print("   (the app re-resolves the credential host-side at the next run of each workspace)")
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="change things (default: dry run)")
    parser.add_argument("--only", action="append", choices=["db", "sessions", "git-config", "scratch", "logs", "backups"])
    parser.add_argument("--db", default=os.path.join(ROOT, "prisma", "dev.db"))
    parser.add_argument("--workspaces", default=os.path.join(ROOT, ".research-workspaces"))
    parser.add_argument("--scratch", default=os.path.join(ROOT, ".agent-scratch"))
    parser.add_argument("--logs", default=os.path.join(ROOT, "logs"))
    parser.add_argument("--backups", action="append", help="directory of database backups (repeatable)")
    args = parser.parse_args()
    areas = set(args.only or ["db", "sessions", "git-config", "scratch", "logs", "backups"])
    backups = args.backups or [os.path.join(ROOT, "backups"), os.path.join(ROOT, "prisma", "backups")]

    print("APPLYING CHANGES" if args.apply else "DRY RUN: nothing is changed. Pass --apply to mask.")
    if "db" in areas:
        clean_database(args.db, args.apply)
    if "sessions" in areas:
        clean_sessions(args.workspaces, args.apply)
    if "git-config" in areas:
        clean_git_configs(args.workspaces, args.apply)
    if "scratch" in areas:
        clean_tree("per-run scratch", args.scratch, args.apply, max_bytes=256 << 20)
    if "logs" in areas:
        clean_tree("service logs", args.logs, args.apply)
    if "backups" in areas:
        for directory in backups:
            # Raw, in place: a backup is not opened as a database, so nothing but
            # the secret bytes changes. A secret split across two database pages
            # is not seen; replace old backups with fresh ones once the live
            # database is clean if that matters.
            clean_tree("database backups (raw files)", directory, args.apply)
    print("\nDone." + ("" if args.apply else " This was a dry run."))


if __name__ == "__main__":
    sys.exit(main())
