import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { statePath } from "./state-path"

/**
 * Diagnostics log for the plugin.
 *
 * OpenCode's V2 plugin API has no logger: the context exposes the app
 * metadata, the location, and the domain APIs, but nothing that writes to the
 * server log. Plugin `console.error` output does not reach the OpenCode log
 * either, so a failure inside the plugin is invisible to anything that only
 * watches the host log.
 *
 * The plugin therefore keeps its own diagnostics log next to the goal state
 * file, where a monitor can read it. The host log stays the primary source;
 * this file covers the failures the host log cannot show.
 */

/** Rotate once the log passes this size so a failure loop cannot fill the disk. */
const MAX_LOG_BYTES = 1024 * 1024

export function diagnosticsLogPath() {
  return join(dirname(statePath()), "goal-plugin.log")
}

function rotateIfNeeded(path: string) {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return
  }
  if (size < MAX_LOG_BYTES) return
  const previous = `${path}.1`
  try {
    unlinkSync(previous)
  } catch {
    // A missing previous file is the normal case.
  }
  try {
    renameSync(path, previous)
  } catch {
    // If the rotation fails the log keeps growing to the next write, which
    // is still bounded by the check below.
  }
}

/**
 * Append one diagnostics line. Never throws: a failing diagnostics writer
 * must not turn a recoverable plugin error into a crash.
 */
export function reportPluginError(message: string, error?: unknown) {
  try {
    const path = diagnosticsLogPath()
    mkdirSync(dirname(path), { recursive: true })
    rotateIfNeeded(path)
    const detail =
      error === undefined
        ? ""
        : ` | ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
    appendFileSync(path, `${new Date().toISOString()} | error | ${message}${detail}\n`)
  } catch {
    // Diagnostics must never break plugin control flow.
  }
}
