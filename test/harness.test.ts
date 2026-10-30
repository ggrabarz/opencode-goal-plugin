import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("preload protects caller state and late callbacks after fixture cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-harness-probe-"))
  try {
    const callerState = join(dir, "caller-goals.json")
    const callerData = join(dir, "caller-data")
    const defaultState = join(callerData, "opencode-goal-plugin", "goals.json")
    await mkdir(join(callerData, "opencode-goal-plugin"), { recursive: true })
    await writeFile(callerState, "explicit sentinel")
    await writeFile(defaultState, "default sentinel")
    await writeFile(join(dir, "probe.test.ts"), `
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { join } from "node:path"
import { createGoal } from ${JSON.stringify(resolve("src/state.ts"))}
import { statePath } from ${JSON.stringify(resolve("src/state-path.ts"))}
let pending: Promise<void>
afterEach(async () => { await pending })
test("late state write after fixture cleanup stays isolated", async () => {
  const fallback = process.env.OPENCODE_GOAL_STATE_PATH!
  await createGoal("early", "preload protected explicit caller path", null)
  expect(JSON.parse(await readFile(fallback, "utf8")).goals.early.objective).toBe("preload protected explicit caller path")
  const fixture = await mkdtemp(join(${JSON.stringify(dir)}, "fixture-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(fixture, "goals.json")
  pending = new Promise((done, reject) => setTimeout(async () => {
    try {
      delete process.env.OPENCODE_GOAL_STATE_PATH
      await createGoal("late", "late callback", null)
      const state = JSON.parse(await readFile(statePath(), "utf8"))
      expect(state.goals.late.objective).toBe("late callback")
      expect(await readFile(${JSON.stringify(callerState)}, "utf8")).toBe("explicit sentinel")
      expect(await readFile(${JSON.stringify(defaultState)}, "utf8")).toBe("default sentinel")
      process.env.OPENCODE_GOAL_STATE_PATH = fallback
      done()
    } catch (error) { reject(error) }
  }, 10))
  process.env.OPENCODE_GOAL_STATE_PATH = fallback
  await rm(fixture, { recursive: true, force: true })
})
`)
    const child = Bun.spawn([process.execPath, "test", join(dir, "probe.test.ts")], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: dir, XDG_DATA_HOME: callerData, OPENCODE_GOAL_STATE_PATH: callerState },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ code, stdout, stderr }).toMatchObject({ code: 0 })
    expect(await readFile(callerState, "utf8")).toBe("explicit sentinel")
    expect(await readFile(defaultState, "utf8")).toBe("default sentinel")
    const workerState = join(dir, "worker-goals.json")
    await writeFile(join(dir, "worker.ts"), `
import { createGoal } from ${JSON.stringify(resolve("src/state.ts"))}
await createGoal("worker", "explicit worker state", null)
`)
    const worker = Bun.spawn([process.execPath, "run", join(dir, "worker.ts")], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: dir, XDG_DATA_HOME: callerData, OPENCODE_GOAL_STATE_PATH: workerState },
      stdout: "ignore",
      stderr: "pipe",
    })
    const [workerErrors, workerCode] = await Promise.all([new Response(worker.stderr).text(), worker.exited])
    expect({ code: workerCode, stderr: workerErrors }).toEqual({ code: 0, stderr: "" })
    expect(JSON.parse(await readFile(workerState, "utf8")).goals.worker.objective).toBe("explicit worker state")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
