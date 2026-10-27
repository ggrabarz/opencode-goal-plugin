import { createInterface } from "node:readline"
import { defaultAtomicWriteOps } from "../../src/atomic-write"
import { accountUsage, createGoal } from "../../src/state"

const [, , mode, file, id, count = "1"] = process.argv
if (!mode || !file || !id) throw new Error("Expected mode, isolated state path and writer id")
process.env.OPENCODE_GOAL_STATE_PATH = file
const input = createInterface({ input: process.stdin })
const commands = input[Symbol.asyncIterator]()
function emit(event: string) { console.log(event) }
async function command() {
  if ((await commands.next()).done) throw new Error("Parent closed the command pipe")
}
async function observeSQLite() {
  const specifier = process.versions.bun ? "bun:sqlite" : "node:sqlite"
  function observe(prototype: { exec(sql: string): unknown }) {
    const exec = prototype.exec
    prototype.exec = function (sql) {
      try { return exec.call(this, sql) } catch (error) {
        if (sql === "BEGIN IMMEDIATE") emit("contended")
        throw error
      }
    }
  }
  if (process.versions.bun) {
    const sqlite: typeof import("bun:sqlite") = await import(specifier)
    observe(sqlite.Database.prototype)
    return () => new sqlite.Database(`${file}.coord.sqlite`).close()
  }
  const sqlite: typeof import("node:sqlite") = await import(specifier)
  observe(sqlite.DatabaseSync.prototype)
  return () => new sqlite.DatabaseSync(`${file}.coord.sqlite`).close()
}
try {
  const closeOtherConnection = await observeSQLite()
  emit("ready")
  await command()
  if (mode === "before-rename" || mode === "after-rename" || mode === "close-other") {
    const rename = defaultAtomicWriteOps.rename
    defaultAtomicWriteOps.rename = async (from, to) => {
      if (to !== file) return rename(from, to)
      if (mode === "after-rename") await rename(from, to)
      if (mode === "close-other") closeOtherConnection()
      emit(mode)
      await command()
      if (mode !== "after-rename") await rename(from, to)
    }
  }
  emit("attempting")
  if (mode === "usage") {
    for (let index = 1; index <= Number(count); index++) {
      await accountUsage("shared", 1, { cumulative: true, source: `${id}-${index}`, initialBaseline: 0 })
      emit("ack")
    }
  } else {
    await createGoal(id, `Written by ${id}`, null)
    emit("ack")
  }
  emit("done")
} catch (error) {
  console.error(error)
  emit("failed")
  process.exitCode = 1
} finally {
  input.close()
  process.stdin.destroy()
}
