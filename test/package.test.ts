import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { mkdir, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { satisfies } from "semver"

test("published tui entrypoint shares host runtime instances via peerDependencies", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  const runtimeImports = ["@opentui/solid", "solid-js"]

  for (const dependency of runtimeImports) {
    // The TUI host provides its own OpenTUI/solid instances; shipping a
    // second copy in dependencies would break rendering across them.
    expect(packageJson.peerDependencies?.[dependency]).toBeString()
    expect(packageJson.dependencies?.[dependency]).toBeUndefined()
    // Local development keeps its own copies for typecheck and tests.
    expect(packageJson.devDependencies?.[dependency]).toBeString()
  }
})

test("the packed plugin resolves through Bun and Node CommonJS and ESM entrypoints", async () => {
  const root = mkdtempSync(join(tmpdir(), "goal-package-resolution-"))
  try {
    const packed = Bun.spawnSync(["npm", "pack", "--ignore-scripts", "--pack-destination", root], {
      stdout: "pipe", stderr: "pipe",
    })
    if (packed.exitCode !== 0) throw new Error(packed.stderr.toString())
    const tarball = readdirSync(root).find((file) => file.endsWith(".tgz"))
    if (!tarball) throw new Error("npm pack did not produce a package")
    await new Bun.Archive(await Bun.file(join(root, tarball)).arrayBuffer()).extract(join(root, "unpacked"))
    const scope = join(root, "node_modules", "@prevalentware")
    await mkdir(scope, { recursive: true })
    await rename(join(root, "unpacked", "package"), join(scope, "opencode-goal-plugin"))
    const name = "@prevalentware/opencode-goal-plugin"
    const entrypoints = { "": "dist/server.js", "/server": "dist/server.js", "/tui": "src/tui.ts" }
    for (const [suffix, target] of Object.entries(entrypoints)) {
      expect(Bun.resolveSync(name + suffix, root)).toBe(realpathSync(join(root, "node_modules", name, target)))
    }
    const checked = Bun.spawnSync(["node", "--input-type=module", "-e", `
      import assert from "node:assert/strict"
      import { existsSync } from "node:fs"
      import { createRequire } from "node:module"
      import { resolve } from "node:path"
      import { fileURLToPath } from "node:url"
      const require = createRequire(resolve("consumer.cjs"))
      const name = "@prevalentware/opencode-goal-plugin"
      for (const [suffix, target] of Object.entries(${JSON.stringify(entrypoints)})) {
        const expected = resolve("node_modules", name, target)
        assert.ok(existsSync(expected), "Missing published entrypoint: " + expected)
        assert.equal(require.resolve(name + suffix), expected)
        assert.equal(fileURLToPath(import.meta.resolve(name + suffix)), expected)
      }
    `], { cwd: root, stdout: "pipe", stderr: "pipe" })
    if (checked.exitCode !== 0) throw new Error(checked.stderr.toString())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test("engines.opencode covers the V2 beta line and the V1 floor while excluding older stable releases", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    engines?: Record<string, string>
  }
  const range = packageJson.engines?.opencode
  expect(range).toBeString()
  if (typeof range !== "string") throw new Error("expected engines.opencode to be a string range")

  // The range must cover the 0.0.0-beta-* V2 line and the V1 floor 1.17.1
  // while excluding unsupported stable pre-1.17.1 releases.
  for (const version of ["0.0.0-beta-0", "0.0.0-beta-19425", "1.17.1", "1.17.2", "2.0.0"]) {
    expect(satisfies(version, range)).toBe(true)
  }
  for (const version of ["0.0.0", "0.0.1", "0.5.0", "1.0.0", "1.17.0"]) {
    expect(satisfies(version, range)).toBe(false)
  }
})
