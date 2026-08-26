#!/usr/bin/env bash
# Daily off-tree snapshot of the r-docs SQLite database.
#
# Runs as ROOT (systemd unit nr-rdocs-db-backup.service) so the finished
# backups land in /var/backups/r-docs owned by root with mode 444 — the
# `niels` user (and any agent running as niels) can read them but cannot
# delete or overwrite them. That is the point: agents and deploy scripts
# work as niels, so a bug or bad `rm -rf` cannot take the backups with it.
#
# The actual DB read happens AS NIELS (runuser) via python3's sqlite3
# backup API. Two reasons:
#   - the backup API takes the proper locks, so the snapshot is consistent
#     even while the live app is writing (WAL mode);
#   - root touching the live DB could leave root-owned -wal/-shm files next
#     to prisma/dev.db when the app is idle, which would break the app.
#
# Idempotent: one backup per calendar day; reruns exit 0 without work.
# Retention: KEEP_DAYS days of dailies, pruned by root here.
set -euo pipefail

DB=/home/niels/agents/automator/services/r-docs/prisma/dev.db
DEST_DIR=/var/backups/r-docs
STAGING="$DEST_DIR/.staging"   # niels-writable scratch; finals are root-owned
RUN_AS=niels
RUNUSER=/usr/sbin/runuser
KEEP_DAYS=30

STAMP="$(date +%F)"
OUT="$DEST_DIR/dev-$STAMP.db.gz"

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (systemd runs this via nr-rdocs-db-backup.service)" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
chown root:root "$DEST_DIR"
chmod 755 "$DEST_DIR"

if [ -e "$OUT" ]; then
  echo "already have $OUT — nothing to do"
  exit 0
fi

mkdir -p "$STAGING"
chown "$RUN_AS:$RUN_AS" "$STAGING"
chmod 700 "$STAGING"
SNAP="$STAGING/dev-$STAMP.db"
rm -f "$STAGING"/dev-*.db "$STAGING"/dev-*.db.gz

# Consistent online snapshot + integrity check, as niels.
"$RUNUSER" -u "$RUN_AS" -- python3 - "$DB" "$SNAP" <<'PY'
import sqlite3, sys
src_path, dst_path = sys.argv[1], sys.argv[2]
src = sqlite3.connect(src_path)
dst = sqlite3.connect(dst_path)
with dst:
    src.backup(dst)
check = dst.execute("PRAGMA quick_check").fetchone()[0]
src.close(); dst.close()
if check != "ok":
    sys.exit(f"quick_check failed on snapshot: {check}")
print(f"snapshot ok: {dst_path}")
PY

"$RUNUSER" -u "$RUN_AS" -- gzip -f "$SNAP"

# Promote to root-owned, read-only for everyone else.
mv "$SNAP.gz" "$OUT"
chown root:root "$OUT"
chmod 444 "$OUT"

# Prune old dailies (root-only operation, by design).
find "$DEST_DIR" -maxdepth 1 -name 'dev-*.db.gz' -mtime +"$KEEP_DAYS" -delete

echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1)), keeping last $KEEP_DAYS days"
