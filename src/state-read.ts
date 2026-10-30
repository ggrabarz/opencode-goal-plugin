import { readFile } from "node:fs/promises"

export type StateReadOps = {
  platform: NodeJS.Platform
  readFile: (path: string) => Promise<string>
  sleep: (ms: number) => Promise<void>
}

export const READ_ATTEMPTS = 5

export const READ_RETRY_DELAY_MS = 10

export const MISSING_READ_ATTEMPTS = 3
export const MISSING_READ_RETRY_DELAY_MS = 2

export const defaultStateReadOps: StateReadOps = {
  platform: process.platform,
  readFile: (path) => readFile(path, "utf8"),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}

export function isTransientReadError(error: unknown, platform: NodeJS.Platform): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === "ENOENT") return true
  if (platform !== "win32") return false
  return code === "EPERM" || code === "EACCES" || code === "EBUSY"
}

export async function readStateFile(file: string, ops: StateReadOps = defaultStateReadOps): Promise<string> {
  let missingAttempts = 0
  for (let attempt = 1; ; attempt++) {
    try {
      return await ops.readFile(file)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === "ENOENT") {
        missingAttempts += 1
        if (missingAttempts >= MISSING_READ_ATTEMPTS) throw error
        await ops.sleep(MISSING_READ_RETRY_DELAY_MS)
        continue
      }
      if (attempt >= READ_ATTEMPTS || !isTransientReadError(error, ops.platform)) throw error
      await ops.sleep(READ_RETRY_DELAY_MS)
    }
  }
}
