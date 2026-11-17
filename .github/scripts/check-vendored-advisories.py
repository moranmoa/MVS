#!/usr/bin/env python3
"""RustSec watch for the crates vendored under core/vendor.

cargo-deny and cargo-audit match advisories only against registry crates.
A path crate from [patch.crates-io] is invisible to them, so this script
checks the RustSec advisory database for each vendored crate under its
crates.io name, at the upstream version whose code we actually ship.

Usage: check-vendored-advisories.py <advisory-db checkout>
Exits 1 if an advisory affects a vendored crate and is not listed in
ACCEPTED below.

Remove this script and its CI step with the libp2p 0.57 upgrade, together
with core/vendor/ (see the READMEs there).
"""
import pathlib
import re
import sys
import tomllib

# crate -> the upstream version whose source we ship (not the manifest
# version: libp2p-dns is the 0.45.0 source in a manifest that says 0.44.0).
VENDORED = {
    "libp2p-dns": "0.45.0",
    "libp2p-gossipsub": "0.49.5",
}

# Advisories fixed by the patch we apply (see that crate's README).
ACCEPTED = {
    "libp2p-gossipsub": {
        "RUSTSEC-2026-0534": "upstream-9c64782-prune-unknown-topics.patch",
    },
}


def parse(v):
    parts = [int(p) for p in v.strip().split("-")[0].split("+")[0].split(".")]
    return tuple(parts + [0] * (3 - len(parts)))[:3], len(parts)


def matches_one(version, comparator):
    m = re.fullmatch(r"\s*(>=|<=|>|<|=|\^|~)?\s*([0-9][0-9.]*)\s*", comparator)
    if not m:
        raise ValueError(f"unsupported version requirement: {comparator!r}")
    op, (want, given) = m.group(1) or "^", parse(m.group(2))
    if op == ">=":
        return version >= want
    if op == ">":
        return version > want
    if op == "<=":
        return version <= want
    if op == "<":
        return version < want
    if op == "=":
        return version[:given] == want[:given]
    if op == "~":
        upper = (want[0] + 1, 0, 0) if given == 1 else (want[0], want[1] + 1, 0)
        return want <= version < upper
    # caret: the left-most non-zero component (of those given) is fixed
    if want[0] > 0 or given == 1:
        upper = (want[0] + 1, 0, 0)
    elif want[1] > 0 or given == 2:
        upper = (0, want[1] + 1, 0)
    else:
        upper = (0, 0, want[2] + 1)
    return want <= version < upper


def matches(version, requirement):
    return all(matches_one(version, c) for c in requirement.split(","))


def front_matter(path):
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".toml":
        return tomllib.loads(text), ""
    m = re.match(r"\s*```toml\n(.*?)\n```", text, re.S)
    if not m:
        raise ValueError(f"{path}: no TOML front matter")
    title = re.search(r"^# (.+)$", text[m.end():], re.M)
    return tomllib.loads(m.group(1)), title.group(1).strip() if title else ""


def main(db):
    crates_dir = pathlib.Path(db) / "crates"
    if not crates_dir.is_dir():
        sys.exit(f"{db}: not a RustSec advisory-db checkout")
    failed = False
    for crate, ver in VENDORED.items():
        version, _ = parse(ver)
        found = []
        for path in sorted((crates_dir / crate).glob("RUSTSEC-*")):
            adv, title = front_matter(path)
            info, versions = adv["advisory"], adv.get("versions", {})
            if info.get("withdrawn"):
                continue
            safe = versions.get("patched", []) + versions.get("unaffected", [])
            if any(matches(version, r) for r in safe):
                continue
            found.append(info["id"])
            accepted = ACCEPTED.get(crate, {}).get(info["id"])
            if accepted:
                print(f"accepted: {crate} {ver} {info['id']} (fixed by {accepted})")
            else:
                failed = True
                print(f"AFFECTED: {crate} {ver} {info['id']}: {title}")
        if not found:
            print(f"ok: {crate} {ver} has no open advisories")
    return 1 if failed else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1]))
