import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MISSING_READ_ATTEMPTS,
  MISSING_READ_RETRY_DELAY_MS,
  READ_ATTEMPTS,
  READ_RETRY_DELAY_MS,
  isTransientReadError,
  readStateFile,
  type StateReadOps,
} from "../src/state-read"

function errno(code: string, message: string) {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

function makeOps(readFile: StateReadOps["readFile"], platform: NodeJS.Platform = "win32"): StateReadOps {
  return { platform, readFile, sleep: async () => {} }
}

test("a transient missing file is retried", async () => {
  let attempts = 0
  const ops = makeOps(async (path) => {
    attempts += 1
    if (attempts === 1) throw errno("ENOENT", "no such file")
    return await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"))
  })
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-read-"))
  try {
    const file = join(dir, "goals.json")
    await writeFile(file, "payload")
    expect(await readStateFile(file, ops)).toBe("payload")
    expect(attempts).toBe(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a genuine failure is not retried", async () => {
  let attempts = 0
  const ops = makeOps(async () => {
    attempts += 1
    throw errno("EIO", "input/output error")
  })
  await expect(readStateFile("C:/nowhere/goals.json", ops)).rejects.toThrow()
  expect(attempts).toBe(1)
})

test("transient read errors are classified per platform", () => {
  expect(isTransientReadError(errno("ENOENT", "gone"), "win32")).toBe(true)
  expect(isTransientReadError(errno("EPERM", "denied"), "win32")).toBe(true)
  expect(isTransientReadError(errno("EPERM", "denied"), "linux")).toBe(false)
  expect(isTransientReadError(errno("EIO", "io"), "win32")).toBe(false)
  expect(READ_RETRY_DELAY_MS).toBeGreaterThan(0)
})

test("a missing state file requests only two short delays", async () => {
  let attempts = 0
  const delays: number[] = []
  const ops = makeOps(async () => {
    attempts += 1
    throw errno("ENOENT", "no such file")
  })
  ops.sleep = async (ms) => { delays.push(ms) }
  await expect(readStateFile("C:/nowhere/goals.json", ops)).rejects.toThrow()
  expect(attempts).toBe(MISSING_READ_ATTEMPTS)
  expect(delays).toEqual([MISSING_READ_RETRY_DELAY_MS, MISSING_READ_RETRY_DELAY_MS])
})

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`Windows state reads recover from ${code}`, async () => {
    let attempts = 0
    const ops = makeOps(async () => {
      if (++attempts < 3) throw errno(code, "locked")
      return "persisted JSON"
    })
    expect(await readStateFile("isolated.json", ops)).toBe("persisted JSON")
    expect(attempts).toBe(3)
  })

  test(`Windows state reads exhaust ${code}`, async () => {
    let attempts = 0
    const ops = makeOps(async () => { attempts++; throw errno(code, "locked") })
    await expect(readStateFile("isolated.json", ops)).rejects.toThrow("locked")
    expect(attempts).toBe(READ_ATTEMPTS)
  })

  test(`POSIX state reads reject ${code} immediately`, async () => {
    let attempts = 0
    const ops = makeOps(async () => { attempts++; throw errno(code, "denied") }, "linux")
    await expect(readStateFile("isolated.json", ops)).rejects.toThrow("denied")
    expect(attempts).toBe(1)
  })
}

test("mixed transient and missing errors retain a bounded total retry budget", async () => {
  let attempts = 0
  let waits = 0
  const ops = makeOps(async () => {
    attempts++
    throw errno(attempts < 5 ? "EBUSY" : "ENOENT", "unavailable")
  })
  ops.sleep = async () => { waits++ }
  await expect(readStateFile("isolated.json", ops)).rejects.toThrow("unavailable")
  expect(attempts).toBe(7)
  expect(waits).toBe(6)
})
