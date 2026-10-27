import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { stateWorker } from "./state-process"

if (process.env.OPENCODE_REQUIRE_WINDOWS_TEST === "1" && process.platform !== "win32") {
  throw new Error("The native Windows gate must run on Windows instead of skipping")
}

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

for (const runtime of [process.execPath, "node"]) {
  const other = runtime === "node" ? process.execPath : "node"
  for (const stage of ["before-rename", "after-rename"]) {
    test(`${runtime} death ${stage} releases ownership and preserves valid JSON`, async () => {
      const file = join(root, `${runtime === "node" ? "node" : "bun"}-${stage}`, "goals.json")
      const seed = stateWorker(other, entry, "create", file, "seed")
      const owner = stateWorker(runtime, entry, stage, file, "owner")
      const waiter = stateWorker(other, entry, "create", file, "waiter")
      try {
        await seed.start()
        await seed.done()
        await owner.start()
        await owner.event(stage)
        await waiter.start()
        await waiter.event("contended")
        expect(waiter.events).not.toContain("ack")
        await owner.stop()
        await waiter.done()
        const state = JSON.parse(await readFile(file, "utf8"))
        expect(Object.keys(state.goals).sort()).toEqual(stage === "before-rename"
          ? ["seed", "waiter"] : ["owner", "seed", "waiter"])
      } finally {
        await Promise.all([seed.stop(), owner.stop(), waiter.stop()])
      }
    }, 25_000)
  }

  test(`${runtime} closing another SQLite connection preserves external exclusion`, async () => {
    const file = join(root, `other-connection-${runtime === "node" ? "node" : "bun"}`, "goals.json")
    const owner = stateWorker(runtime, entry, "close-other", file, "owner")
    const waiter = stateWorker(other, entry, "create", file, "waiter")
    try {
      await owner.start()
      await owner.event("close-other")
      await waiter.start()
      await waiter.event("contended")
      expect(waiter.events).not.toContain("ack")
      owner.command()
      await Promise.all([owner.done(), waiter.done()])
      expect(Object.keys(JSON.parse(await readFile(file, "utf8")).goals).sort()).toEqual(["owner", "waiter"])
    } finally {
      await Promise.all([owner.stop(), waiter.stop()])
    }
  }, 20_000)
}

test("synchronized first-directory writers preserve every acknowledged goal", async () => {
  const file = join(root, "first", "nested", "goals.json")
  const workers = Array.from({ length: 6 }, (_, index) =>
    stateWorker(index % 2 ? "node" : process.execPath, entry, "create", file, `writer-${index}`))
  try {
    await Promise.all(workers.map((worker) => worker.event("ready")))
    workers.forEach((worker) => worker.command())
    await Promise.all(workers.map((worker) => worker.done()))
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")).goals).sort())
      .toEqual(workers.map((_, index) => `writer-${index}`))
    expect(workers.every((worker) => worker.events.includes("ack"))).toBe(true)
  } finally {
    await Promise.all(workers.map((worker) => worker.stop()))
  }
}, 25_000)

test("concurrent cumulative updates to one session conserve all acknowledgements", async () => {
  const file = join(root, "usage", "goals.json")
  const seed = stateWorker(process.execPath, entry, "create", file, "shared")
  const workers = Array.from({ length: 4 }, (_, index) =>
    stateWorker(index % 2 ? "node" : process.execPath, entry, "usage", file, `writer-${index}`, 30))
  try {
    await seed.start()
    await seed.done()
    await Promise.all(workers.map((worker) => worker.event("ready")))
    workers.forEach((worker) => worker.command())
    await Promise.all(workers.map((worker) => worker.done()))
    const acknowledgements = workers.flatMap((worker) => worker.events.filter((event) => event === "ack"))
    expect(acknowledgements).toHaveLength(120)
    expect(JSON.parse(await readFile(file, "utf8")).goals.shared.tokensUsed).toBe(120)
  } finally {
    await Promise.all([seed.stop(), ...workers.map((worker) => worker.stop())])
  }
}, 30_000)

test.skipIf(process.platform === "win32")("a suspended owner remains exclusive beyond the former 30-second stale age", async () => {
  const directory = join(root, "paused")
  const alias = join(root, "paused-alias")
  await mkdir(directory)
  await symlink(directory, alias, "dir")
  const file = join(directory, "goals.json")
  const owner = stateWorker(process.execPath, entry, "before-rename", file, "owner")
  const waiter = stateWorker("node", entry, "create", join(alias, "goals.json"), "timed-out")
  const successor = stateWorker("node", entry, "create", file, "successor")
  try {
    await owner.start()
    await owner.event("before-rename")
    owner.child.kill("SIGSTOP")
    const pausedAt = performance.now()
    await waiter.start()
    await waiter.event("contended")
    await waiter.event("failed")
    expect(waiter.events).not.toContain("ack")
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" })
    await sleep(Math.max(0, 31_000 - (performance.now() - pausedAt)))
    await successor.start()
    await successor.event("contended")
    expect(successor.events).not.toContain("ack")
    owner.child.kill("SIGCONT")
    owner.command()
    await Promise.all([owner.done(), successor.done()])
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")).goals).sort()).toEqual(["owner", "successor"])
  } finally {
    await Promise.all([owner.stop(), waiter.stop(), successor.stop()])
  }
}, 50_000)

test("an unrelated state file progresses while another writer owns its path", async () => {
  const file = join(root, "independent", "goals.json")
  const owner = stateWorker(process.execPath, entry, "before-rename", file, "owner")
  const other = stateWorker("node", entry, "create", join(root, "independent", "other.json"), "other")
  try {
    await owner.start()
    await owner.event("before-rename")
    await other.start()
    await other.done()
    expect(owner.events).not.toContain("ack")
  } finally {
    await Promise.all([owner.stop(), other.stop()])
  }
}, 20_000)
