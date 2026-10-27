import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { stateWorker } from "./state-process"

let root: string
let entry: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "goal-state-process-"))
  entry = join(root, "worker.mjs")
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures", "state-worker.ts")],
    outdir: root, naming: "worker.mjs", target: "node",
  })
  if (!build.success) throw new Error(build.logs.join("\n"))
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

test("a delayed JSON publication preserves every acknowledged goal", async () => {
  const file = join(root, "delayed", "goals.json")
  // Seed the parent so the regression measures ownership, not directory setup.
  const seed = stateWorker(process.execPath, entry, "create", file, "seed")
  const owner = stateWorker(process.execPath, entry, "before-rename", file, "owner")
  const waiter = stateWorker(process.execPath, entry, "create", file, "waiter")
  try {
    await seed.start()
    await seed.done()
    await owner.start()
    await owner.event("before-rename")
    await waiter.start()
    await waiter.event("attempting")
    await sleep(5_500)
    owner.command()
    await Promise.all([owner.done(), waiter.done()])
    const state = JSON.parse(await readFile(file, "utf8"))
    expect(Object.keys(state.goals).sort()).toEqual(["owner", "seed", "waiter"])
    expect(waiter.events).toContain("ack")
  } finally {
    await Promise.all([seed.stop(), owner.stop(), waiter.stop()])
  }
}, 20_000)
