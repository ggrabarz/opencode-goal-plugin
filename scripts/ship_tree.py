#!/usr/bin/env python3
"""Build the `ship` tree: the smallest set of files a `github:` install needs.

Why this script exists: the host loads a plugin's TUI entrypoint **from source**,
so every module the TUI imports has to be present in the install tree. `ship`
carries no dev tooling (that is what makes `github:` installs survive this box's
npm policy, which blocks the native postinstall in the server-side dependency
tree), so it is a hand-picked file list. Hand-picked lists drift: a fork added a
`src/diagnostics.ts` import to `src/tui.ts`, the ship tree kept the old list, and
the plugin failed in the host with `Cannot find module './diagnostics'`. The
closure below is computed from the imports, so that cannot happen again.

Usage: python3 scripts/ship_tree.py <path to a ship worktree>
"""
import io
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_IMPORT = re.compile(r'from\s+"(\./[^"]+)"')


def resolve(rel: str) -> str:
    """Relative imports in this codebase omit the extension, so try the ones the
    host's loader accepts (`.ts`, `.tsx`, `index.ts`) and keep the real path."""
    for cand in (rel, rel + ".ts", rel + ".tsx", rel + "/index.ts", rel + "/index.tsx"):
        if os.path.isfile(os.path.join(ROOT, cand.replace("/", os.sep))):
            return cand
    raise SystemExit(f"imported module is missing: {rel}")


def closure(entry: str) -> list[str]:
    """Every module reachable from `entry` through relative imports."""
    seen: list[str] = []
    queue = [entry]
    while queue:
        rel = resolve(os.path.normpath(queue.pop(0)).replace("\\", "/"))
        if rel in seen:
            continue
        seen.append(rel)
        path = os.path.join(ROOT, rel.replace("/", os.sep))
        text = io.open(path, encoding="utf-8").read()
        for dep in LOCAL_IMPORT.findall(text):
            queue.append(os.path.join(os.path.dirname(rel), dep))
    return seen


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    dest = os.path.abspath(sys.argv[1])
    if not os.path.isdir(dest):
        raise SystemExit(f"not a directory: {dest}")

    # The server side is bundled: dist/server.js is self-contained (only Node
    # builtins and zod are left bare), so its imports need no source files here.
    dist = os.path.join(ROOT, "dist", "server.js")
    if not os.path.isfile(dist):
        raise SystemExit("dist/server.js is missing; run `bun run build` first")

    files = ["README.md", "LICENSE", "dist/server.js"]
    files += [f for f in closure("src/tui.ts") if f not in files]

    for rel in files:
        target = os.path.join(dest, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(os.path.join(ROOT, rel.replace("/", os.sep)), target)

    # The ship package.json carries no scripts, lockfile or dev dependencies: npm
    # must have nothing to run while it prepares the git dependency.
    pkg_path = os.path.join(dest, "package.json")
    pkg = json.load(io.open(pkg_path, encoding="utf-8")) if os.path.isfile(pkg_path) else {}
    src_pkg = json.load(io.open(os.path.join(ROOT, "package.json"), encoding="utf-8"))
    pkg["name"] = src_pkg["name"]
    pkg["version"] = src_pkg["version"]
    pkg["type"] = "module"
    pkg["description"] = src_pkg.get("description", "")
    pkg["main"] = "./dist/server.js"
    pkg["exports"] = {
        ".": "./dist/server.js",
        "./server": {"import": "./dist/server.js", "default": "./dist/server.js"},
        "./tui": {"import": "./src/tui.ts", "default": "./src/tui.ts"},
    }
    pkg["dependencies"] = {"zod": src_pkg.get("dependencies", {}).get("zod", "^4.1.8")}
    pkg["peerDependencies"] = {
        "@opentui/solid": ">=0.5.8",
        "solid-js": ">=1.9.0",
    }
    pkg["peerDependenciesMeta"] = {
        "@opentui/solid": {"optional": True},
        "solid-js": {"optional": True},
    }
    pkg["files"] = ["dist"] + [f for f in files if f.startswith("src/")] + ["LICENSE", "README.md"]
    pkg["engines"] = {"opencode": ">=1.17.1"}
    pkg["license"] = src_pkg.get("license", "MIT")
    pkg.pop("scripts", None)
    pkg.pop("devDependencies", None)
    io.open(pkg_path, "w", encoding="utf-8", newline="\n").write(json.dumps(pkg, indent=2) + "\n")

    print("ship tree written to", dest)
    for rel in files + ["package.json"]:
        print("  ", rel)


if __name__ == "__main__":
    main()
