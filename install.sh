#!/usr/bin/env bash
# Install (or with --uninstall, remove) bd-class-sync for the current user.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
config_home=${XDG_CONFIG_HOME:-$HOME/.config}
bin=$HOME/.local/bin                     # the systemd units call the tools here
share=${XDG_DATA_HOME:-$HOME/.local/share}/bd-class-sync   # bd-reinject's stub loads early-themes.js here
plugins=$config_home/BetterDiscord/plugins
units=$config_home/systemd/user
config=$config_home/bd-class-sync/config.toml
unit_files=(bd-reinject.path bd-reinject.service bd-class-remap.path bd-class-remap.service)

if [ "${1:-}" = "--uninstall" ]; then
    systemctl --user disable --now bd-reinject.path bd-class-remap.path 2>/dev/null || true
    for u in "${unit_files[@]}"; do rm -f "$units/$u"; done
    systemctl --user daemon-reload
    rm -f "$bin/bd-class-remap" "$bin/bd-reinject" "$plugins/ClassSync.plugin.js" "$share/early-themes.js"
    rmdir "$share" 2>/dev/null || true
    # The Discord stub skips a missing early-themes.js, so it is left in place.
    echo "Removed. Kept your config ($config) and ClassSync's records ($config_home/BetterDiscord/data/class-sync)."
    exit 0
fi

[ -d "$config_home/BetterDiscord" ] || { echo "BetterDiscord is not installed ($config_home/BetterDiscord missing)." >&2; exit 1; }

install -Dm755 "$here/bin/bd-class-remap" "$bin/bd-class-remap"
install -Dm755 "$here/bin/bd-reinject" "$bin/bd-reinject"
install -Dm644 "$here/host/early-themes.js" "$share/early-themes.js"
install -Dm644 "$here/plugin/ClassSync.plugin.js" "$plugins/ClassSync.plugin.js"
for u in "${unit_files[@]}"; do install -Dm644 "$here/systemd/$u" "$units/$u"; done
[ -f "$config" ] || install -Dm644 "$here/config.example.toml" "$config"

systemctl --user daemon-reload
systemctl --user enable --now bd-reinject.path bd-class-remap.path
# Brings the stub of a host injected by an older version up to date (loads early-themes.js).
"$bin/bd-reinject" || echo "bd-reinject could not run yet; its path unit tries again at the next Discord update." >&2

cat <<EOF
Installed.
  - Enable the ClassSync plugin in Discord (Settings > Plugins) if it is not enabled yet.
  - Theme targets: $config
  - Check anytime: bd-class-remap   (dry run)   |   bd-reinject   (safe to rerun)
EOF
