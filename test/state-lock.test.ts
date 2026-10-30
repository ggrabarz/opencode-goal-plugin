import { expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withStateLock } from "../src/state-lock"

async function withTempDir(run: (file: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "goal-lock-"))
  try { await run(join(root, "goals.json")) } finally { await rm(root, { recursive: true, force: true }) }
}

test("ownership times out without entering the callback or writing JSON", async () => {
  await withTempDir(async (file) => {
    let entered = false
    await withStateLock(file, async () => {
      await expect(withStateLock(file, async () => {
        entered = true
        await writeFile(file, "unsafe")
      })).rejects.toThrow("Timed out")
      expect(entered).toBe(false)
      await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" })
    })
    expect(await withStateLock(file, async () => "released")).toBe("released")
  })
}, 15_000)

test("invalid parent and nonregular coordinators reject without calling the action", async () => {
  await withTempDir(async (file) => {
    await writeFile(file, "keep")
    let called = false
    await expect(withStateLock(join(file, "goals.json"), async () => { called = true })).rejects.toThrow()
    expect(called).toBe(false)
    expect(await readFile(file, "utf8")).toBe("keep")
  })
})

test.skipIf(process.platform === "win32")("an existing coordinator symlink is preserved and rejected", async () => {
  await withTempDir(async (file) => {
    await writeFile(file, "keep")
    await symlink(file, `${file}.coord.sqlite`)
    let called = false
    await expect(withStateLock(file, async () => { called = true })).rejects.toThrow("regular file")
    expect(called).toBe(false)
    expect((await lstat(`${file}.coord.sqlite`)).isSymbolicLink()).toBe(true)
    expect(await readFile(file, "utf8")).toBe("keep")
  })
})

test("legacy lock files are inert and left untouched", async () => {
  await withTempDir(async (file) => {
    await writeFile(`${file}.lock`, "legacy")
    expect(await withStateLock(file, async () => "owned")).toBe("owned")
    expect(await readFile(`${file}.lock`, "utf8")).toBe("legacy")
  })
})

test.skipIf(process.platform === "win32")("new state parents and existing coordinators have private permissions", async () => {
  await withTempDir(async (file) => {
    const nested = join(file, "nested", "goals.json")
    await withStateLock(nested, async () => {})
    expect((await stat(join(file, "nested"))).mode & 0o777).toBe(0o700)
    expect((await stat(`${nested}.coord.sqlite`)).mode & 0o777).toBe(0o600)
    await chmod(`${nested}.coord.sqlite`, 0o644)
    await withStateLock(nested, async () => {})
    expect((await stat(`${nested}.coord.sqlite`)).mode & 0o777).toBe(0o600)
  })
})

test("action failure remains primary and rollback failure still closes the connection", async () => {
  await withTempDir(async (file) => {
    const primary = new Error("action failed")
    const exec = Database.prototype.exec
    const rollback = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql) {
      if (sql === "ROLLBACK") throw new Error("rollback failed")
      return exec.call(this, sql)
    })
    try {
      await expect(withStateLock(file, async () => { throw primary })).rejects.toBe(primary)
    } finally { rollback.mockRestore() }
    expect(await withStateLock(file, async () => "closed")).toBe("closed")
  })
})

for (const failsAction of [false, true]) {
  test(`connection close failure ${failsAction ? "preserves an action error" : "rejects a successful action"}`, async () => {
    await withTempDir(async (file) => {
      const primary = new Error("action failed")
      const cleanup = new Error("close failed")
      const close = Database.prototype.close
      const closing = spyOn(Database.prototype, "close").mockImplementation(function (this: Database) {
        close.call(this)
        throw cleanup
      })
      try {
        await expect(withStateLock(file, async () => {
          if (failsAction) throw primary
        })).rejects.toBe(failsAction ? primary : cleanup)
      } finally { closing.mockRestore() }
      expect(await withStateLock(file, async () => "closed")).toBe("closed")
    })
  })
}

test("invalid SQLite contents fail before entering the mutation", async () => {
  await withTempDir(async (file) => {
    await writeFile(`${file}.coord.sqlite`, "unrecognized coordinator contents")
    let entered = false
    await expect(withStateLock(file, async () => { entered = true })).rejects.toThrow()
    expect(entered).toBe(false)
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
