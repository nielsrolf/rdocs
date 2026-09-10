#!/usr/bin/env bash
# Install the release watcher as a USER systemd timer (no sudo; needs
# `loginctl enable-linger` so it runs without a login session — already on).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ~/.config/systemd/user
cp rdocs-release-watch.service rdocs-release-watch.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now rdocs-release-watch.timer
systemctl --user list-timers rdocs-release-watch.timer --no-pager
