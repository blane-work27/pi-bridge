#!/usr/bin/env python3
"""Write pi's settings.json from settings.base.json and the optional settings.local.json.

settings.base.json is the shared settings. settings.local.json holds one person's settings and is not
committed. Its objects merge into the base, its lists are added to the base's lists (entries already
there are skipped), and its other values replace the base's.

pi writes `packages` (pi install) and `lastChangelogVersion` into settings.json itself. Those are kept
from the old settings.json.
"""
import json
import os
import sys

RUNTIME_KEYS = ("packages", "lastChangelogVersion")


def fail(message):
    print(f"render-settings: {message}", file=sys.stderr)
    sys.exit(1)


def load(path):
    try:
        value = json.load(open(path))
    except (OSError, ValueError) as e:
        fail(f"cannot read {path}: {e}")
    if not isinstance(value, dict):
        fail(f"{path} must hold a JSON object")
    return value


def merge(base, local):
    out = dict(base)
    for key, value in local.items():
        have = out.get(key)
        if isinstance(have, dict) and isinstance(value, dict):
            out[key] = merge(have, value)
        elif isinstance(have, list) and isinstance(value, list):
            out[key] = have + [x for x in value if x not in have]
        else:
            out[key] = value
    return out


def main():
    root = sys.argv[1]
    path = os.path.join(root, "settings.json")
    local_path = os.path.join(root, "settings.local.json")
    settings = load(os.path.join(root, "settings.base.json"))
    if os.path.exists(local_path):
        settings = merge(settings, load(local_path))
    if os.path.exists(path):
        old = load(path)
        settings.update({k: old[k] for k in RUNTIME_KEYS if k in old})
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    used = "settings.base.json and settings.local.json" if os.path.exists(local_path) else "settings.base.json"
    print(f"Wrote settings.json from {used}.")


if __name__ == "__main__":
    main()
