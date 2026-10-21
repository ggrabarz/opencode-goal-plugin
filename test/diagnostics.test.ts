import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diagnosticsLogPath, reportPluginError } from "../src/diagnostics"

let dir = ""

async function withStatePath<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCODE_GOAL_STATE_PATH
  dir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-diagnostics-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(dir, "goals.json")
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_GOAL_STATE_PATH
    else process.env.OPENCODE_GOAL_STATE_PATH = previous
    await rm(dir, { recursive: true, force: true })
  }
}

test("a reported plugin error is written next to the goal state file", async () => {
  await withStatePath(async () => {
    reportPluginError("Turn watchdog retry failed", new Error("provider unreachable"))
    const contents = await readFile(diagnosticsLogPath(), "utf8")
    expect(contents).toContain("Turn watchdog retry failed")
    expect(contents).toContain("provider unreachable")
    expect(contents).toContain("| error |")
  })
})

test("a reported plugin error without a cause is still recorded", async () => {
  await withStatePath(async () => {
    reportPluginError("V2 event consumer stopped")
    const contents = await readFile(diagnosticsLogPath(), "utf8")
    expect(contents).toContain("V2 event consumer stopped")
  })
})

test("repeated reports append one line each", async () => {
  await withStatePath(async () => {
    reportPluginError("first", new Error("one"))
    reportPluginError("second", new Error("two"))
    const contents = await readFile(diagnosticsLogPath(), "utf8")
    const lines = contents.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("first")
    expect(lines[1]).toContain("second")
  })
})

test("reporting a plugin error never throws", async () => {
  await withStatePath(async () => {
    // A state path whose parent cannot be created must not propagate.
    process.env.OPENCODE_GOAL_STATE_PATH = join(dir, "goals.json")
    expect(() => reportPluginError("still reported")).not.toThrow()
  })
})
