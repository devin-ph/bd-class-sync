"""Tests for bd-class-remap on synthetic builds. Run: python3 -m unittest discover -s tests"""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "bin/bd-class-remap"
loader = importlib.machinery.SourceFileLoader("bd_class_remap", str(SCRIPT))
spec = importlib.util.spec_from_loader("bd_class_remap", loader)
remap = importlib.util.module_from_spec(spec)
loader.exec_module(remap)


def module(hash_, *names):
    return hash_, [f"{n}_{hash_}" for n in names]


def write_builds(data, old, new):
    (data / "builds").mkdir(parents=True)
    for build, modules, seen in (("old", old, "2026-01-01T00:00:00Z"), ("new", new, "2026-02-01T00:00:00Z")):
        (data / "builds" / f"{build}.json").write_text(json.dumps(
            {"build": build, "firstSeen": seen, "lastSeen": seen, "modules": dict(modules)}))
    (data / "latest.json").write_text(json.dumps({"build": "new"}))


class Resolve(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def builds(self, old, new):
        write_builds(self.data, old, new)
        return remap.Builds(self.data)

    def test_renamed_module_follows_its_siblings(self):
        b = self.builds([module("a1b2c3", "chat", "chatContent", "form")],
                        [module("Zq9-xY", "chat", "chatContent", "form"), module("Pp00aa", "chat", "sidebar")])
        mapping, how, pending = remap.resolve(b, {"chatContent_a1b2c3", "form_a1b2c3"})
        self.assertEqual(mapping, {"chatContent_a1b2c3": ".chatContent_Zq9-xY", "form_a1b2c3": ".form_Zq9-xY"})
        self.assertEqual(pending, [])

    def test_old_double_underscore_hashes(self):
        b = self.builds([("5e434", ["content__5e434", "sidebarList__5e434"])],
                        [module("pog62O", "content", "sidebarList")])
        mapping, _, _ = remap.resolve(b, {"content__5e434"})
        self.assertEqual(mapping, {"content__5e434": ".content_pog62O"})

    def test_hash_with_underscore_inside(self):
        b = self.builds([module("abcdef", "chatContent", "form")], [module("z_gUBg", "chatContent", "form")])
        mapping, _, _ = remap.resolve(b, {"chatContent_abcdef"})
        self.assertEqual(mapping, {"chatContent_abcdef": ".chatContent_z_gUBg"})

    def test_split_module_covers_both(self):
        old = [module("201d50", "button", "lookFilled", "sizeSmall", "colorRed")]
        new = [module("9OQtot", "button", "lookFilled", "sizeSmall", "colorRed", "grow"),
               module("hfM7yP", "button", "lookFilled", "sizeSmall", "colorRed", "pill")]
        mapping, _, _ = remap.resolve(self.builds(old, new), {"button_201d50"})
        self.assertEqual(mapping, {"button_201d50": ":is(.button_9OQtot, .button_hfM7yP)"})

    def test_clear_winner_beats_weaker_candidate(self):
        old = [module("201d50", "button", "lookFilled", "sizeSmall", "colorRed")]
        new = [module("9OQtot", "button", "lookFilled", "sizeSmall", "colorRed"),
               module("hfM7yP", "button", "lookFilled", "pill", "grow")]
        mapping, _, _ = remap.resolve(self.builds(old, new), {"button_201d50"})
        self.assertEqual(mapping, {"button_201d50": ".button_9OQtot"})

    def test_unrelated_module_with_same_name_is_not_used(self):
        old = [module("aaaaaa", "container", "header", "body")]
        new = [module("bbbbbb", "container", "avatar", "status", "badge")]
        mapping, _, pending = remap.resolve(self.builds(old, new), {"container_aaaaaa"})
        self.assertEqual(mapping, {})
        self.assertEqual(pending, ["container_aaaaaa"])

    def test_look_alike_tiny_modules_are_refused(self):
        # Two old {container} modules vanish and two new ones appear: nothing tells them apart.
        old = [module("aaaaaa", "container"), module("bbbbbb", "container")]
        new = [module("Cc0000", "container"), module("Dd0000", "container")]
        mapping, _, pending = remap.resolve(self.builds(old, new), {"container_aaaaaa"})
        self.assertEqual(mapping, {})
        self.assertEqual(pending, ["container_aaaaaa"])

    def test_true_module_not_loaded_is_not_replaced_by_a_look_alike(self):
        # The real successor of {container, wrapper} is not loaded yet; another old module with the
        # same names did move, and its successor must not be taken for ours.
        old = [module("aaaaaa", "container", "wrapper"), module("bbbbbb", "container", "wrapper")]
        new = [module("Bb1111", "container", "wrapper")]
        mapping, _, _ = remap.resolve(self.builds(old, new), {"container_aaaaaa"})
        self.assertEqual(mapping, {})

    def test_unchanged_module_is_never_a_rename_target(self):
        old = [module("aaaaaa", "chat", "form"), module("keep00", "chat", "form", "x")]
        new = [module("keep00", "chat", "form", "x")]
        mapping, _, _ = remap.resolve(self.builds(old, new), {"chat_aaaaaa"})
        self.assertEqual(mapping, {})

    def test_unrecorded_class_follows_matched_siblings(self):
        old = [module("c0ffee", "card", "cardHeader")]  # "cardBody" was never recorded
        new = [module("N3wHsh", "card", "cardHeader", "cardBody")]
        mapping, how, _ = remap.resolve(self.builds(old, new), {"card_c0ffee", "cardBody_c0ffee"})
        self.assertEqual(mapping["cardBody_c0ffee"], ".cardBody_N3wHsh")
        self.assertEqual(how["cardBody_c0ffee"], "sibling")

    def test_never_recorded_without_siblings_is_ignored(self):
        b = self.builds([module("aaaaaa", "x", "y")], [module("bbbbbb", "x", "y")])
        mapping, _, pending = remap.resolve(b, {"ghost_123456"})
        self.assertEqual((mapping, pending), ({}, []))

    def test_live_classes_are_untouched(self):
        b = self.builds([module("aaaaaa", "x", "y")], [module("aaaaaa", "x", "y")])
        self.assertEqual(remap.resolve(b, {"x_aaaaaa"})[0], {})


class CommandLine(unittest.TestCase):
    def test_apply_rewrites_backs_up_reports_and_runs_post(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            data = tmp / "data"
            write_builds(data, [module("a1b2c3", "chat", "chatContent", "form")],
                         [module("Zq9-xY", "chat", "chatContent", "form")])
            theme = tmp / "my.theme.css"
            theme.write_text(".chat_a1b2c3 .chatContent_a1b2c3:hover, .theme-dark .form_a1b2c3.chat_a1b2c3 { opacity: 0.5 }\n")
            marker = tmp / "post-ran"
            config = tmp / "config.toml"
            config.write_text(f'targets = ["{theme}"]\npost = ["touch", "{marker}"]\n')
            env = {**os.environ, "XDG_STATE_HOME": str(tmp / "state")}
            dry = subprocess.run([sys.executable, SCRIPT, "--config", config, "--data", data, "--quiet"],
                                 capture_output=True, text=True, env=env, check=True)
            self.assertIn("Would rewrite", dry.stdout)
            self.assertIn("a1b2c3", theme.read_text())
            subprocess.run([sys.executable, SCRIPT, "--config", config, "--data", data, "--apply", "--quiet"],
                           capture_output=True, text=True, env=env, check=True)
            self.assertEqual(theme.read_text(),
                             ".chat_Zq9-xY .chatContent_Zq9-xY:hover, .theme-dark .form_Zq9-xY.chat_Zq9-xY { opacity: 0.5 }\n")
            self.assertEqual(len(list((tmp / "state/bd-class-sync/backups").iterdir())), 1)
            self.assertTrue(marker.exists())
            report = json.loads((data / "report.json").read_text())
            self.assertEqual(report["mapped"]["chatContent_a1b2c3"], ".chatContent_Zq9-xY")
            # a second run finds nothing left to do
            again = subprocess.run([sys.executable, SCRIPT, "--config", config, "--data", data, "--apply", "--quiet"],
                                   capture_output=True, text=True, env=env, check=True)
            self.assertNotIn("Rewriting", again.stdout)


if __name__ == "__main__":
    unittest.main()
