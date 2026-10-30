import { chmod, lstat, mkdir, realpath } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

type Connection = { exec(sql: string): unknown; close(): void }

async function openConnection(file: string): Promise<Connection> {
  // A computed import keeps Bun from resolving the Node-only builtin at build time.
  const specifier = process.versions.bun ? "bun:sqlite" : "node:sqlite"
  if (process.versions.bun) {
    const sqlite: typeof import("bun:sqlite") = await import(specifier)
    return new sqlite.Database(file)
  }
  const sqlite: typeof import("node:sqlite") = await import(specifier)
  return new sqlite.DatabaseSync(file)
}

function isBusy(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  const code = "errcode" in error ? error.errcode : "errno" in error ? error.errno : undefined
  return typeof code === "number" && (code & 255) === 5
}

async function validateCoordinator(file: string) {
  try {
    if (!(await lstat(file)).isFile()) throw new Error(`State coordinator must be a regular file: ${file}`)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return
    throw error
  }
}

function closeConnection(connection: Connection, acquired: boolean) {
  let failure: unknown
  try {
    if (acquired) connection.exec("ROLLBACK")
  } catch (error) {
    failure = error
  }
  try {
    connection.close()
  } catch (error) {
    failure ??= error
  }
  return failure
}

/** Own the complete JSON mutation; process death releases the SQLite transaction. */
export async function withStateLock<T>(stateFile: string, action: () => Promise<T>): Promise<T> {
  const file = resolve(stateFile)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const coordinator = join(await realpath(dirname(file)), `${basename(file)}.coord.sqlite`)
  await validateCoordinator(coordinator)
  const connection = await openConnection(coordinator)
  let acquired = false
  let result: T
  try {
    // Never open/read/close this inode through fs: POSIX close can release SQLite's locks.
    await validateCoordinator(coordinator)
    await chmod(coordinator, 0o600)
    connection.exec("PRAGMA busy_timeout = 0")
    const deadline = performance.now() + 10_000
    for (;;) {
      try {
        connection.exec("BEGIN IMMEDIATE")
        acquired = true
        break
      } catch (error) {
        if (!isBusy(error)) throw error
        if (performance.now() >= deadline) throw new Error(`Timed out waiting for goal state ownership: ${stateFile}`, { cause: error })
        await sleep(20)
      }
    }
    result = await action()
  } catch (error) {
    closeConnection(connection, acquired)
    throw error
  }
  const failure = closeConnection(connection, acquired)
  if (failure !== undefined) throw failure
  return result
}
