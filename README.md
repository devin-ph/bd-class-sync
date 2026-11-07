# bd-class-sync

Keep a BetterDiscord setup alive across Discord updates, on Linux.

Discord updates break a themed client in two ways:

1. **The host update drops BetterDiscord.** Each Discord host version is installed into a fresh
   `~/.config/discord/app-<version>/`, without BetterDiscord's injection.
2. **Class renames break themes.** Discord's CSS classes look like `chatContent_z_gUBg`: a name and a
   hash shared by one CSS module. When an update changes the hashes, every theme selector that uses
   them stops matching. In November 2026 Discord moved to rspack and renamed *all* of them, which
   left 1046 of 1200 rules dead in a Translucence-based theme.

bd-class-sync fixes both, without network access and without guessing:

| Part | What it does |
| --- | --- |
| `ClassSync.plugin.js` | BetterDiscord plugin. Records the CSS classes of every Discord build it runs on (`~/.config/BetterDiscord/data/class-sync/`). Shows a notice when your themes were remapped. |
| `bd-class-remap` | Compares the build your theme was written against with the current one and rewrites the renamed classes in your theme files. A dry run unless `--apply`; backs up every file it changes. |
| `bd-reinject` | Re-applies BetterDiscord's injection to the newest Discord host. Safe to run at any time. |
| `systemd/` | User units: re-inject as soon as Discord installs a new host, and remap whenever ClassSync records a new build. |

## How the remap decides

A CSS module is identified by its set of class *names* (`chat`, `chatContent`, `form`, …), which
survive a rename while the hash does not. For each class your theme uses that no longer exists:

- **Module match.** The vanished module is matched to a module that is new in this build when their
  name sets are similar (Jaccard ≥ 0.5) and each is the other's unambiguous best match. A module
  Discord split in two becomes `:is(.a, .b)`. Look-alike tiny modules (Discord has hundreds of
  `{container}`) tie and are refused instead of guessed.
- **Sibling match.** A class that was never recorded follows its module siblings that did match, if
  `name_<new hash>` exists.
- **Pending.** Anything else is left untouched. A module may simply not be loaded yet (a settings
  page you have not opened), so the plugin rescans every 10 minutes and the remap retries.

A module whose hash is present in both builds is the same module and never a rename target.

Measured on a simulated full rename of a real 6000-line theme (2351 modules, 15 % of them not
loaded): 426 of 434 reachable classes remapped correctly, 8 refused as ambiguous, 0 wrong.

## Install

Requirements: BetterDiscord, Python 3.11+, systemd (user session), `notify-send` (optional).

```sh
git clone https://github.com/<you>/bd-class-sync ~/src/bd-class-sync
~/src/bd-class-sync/install.sh
```

Then enable **ClassSync** in Discord (Settings → Plugins). Its first record is a baseline; from the
next Discord update on, renames are handled automatically.

Uninstall: `install.sh --uninstall` (keeps your config and the records).

## Configure

`~/.config/bd-class-sync/config.toml` (see `config.example.toml`):

```toml
targets = ["~/.config/BetterDiscord/themes/*.theme.css"]
# For a theme generated from a template, fix the template and regenerate:
# targets = ["~/.config/wallust/templates/discord.theme.css"]
# post = ["theme-update", "--generate-only"]
```

## Use by hand

```sh
bd-class-remap            # what would change (dry run)
bd-class-remap --apply    # rewrite; backups in ~/.local/state/bd-class-sync/backups
bd-reinject               # re-inject BetterDiscord into the newest Discord host
```

## Limits

- Only **renames** are handled. If Discord restructures a component (removes, merges, changes the
  markup), the CSS needs a human; the plugin's notice tells you something changed.
- The plugin only runs while BetterDiscord does. If a BetterDiscord release itself breaks on a new
  Discord, update BetterDiscord first.
- The first Discord session after a host update starts without BetterDiscord (the update happens
  while Discord launches); `bd-reinject` fixes it right away and asks you to restart Discord.
- The units watch `~/.config/discord*` (Discord's default location).

## Tests

```sh
python3 -m unittest discover -s tests
```

## License

MIT
