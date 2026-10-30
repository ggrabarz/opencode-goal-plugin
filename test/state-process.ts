import { spawn } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"

export function stateWorker(runtime: string, entry: string, mode: string, file: string, id: string, count = 1) {
  const child = spawn(runtime, [entry, mode, file, id, String(count)], {
    env: { ...process.env, OPENCODE_GOAL_STATE_PATH: file },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const events: string[] = []
  let output = ""
  let errors = ""
  child.stdout.on("data", (chunk) => {
    output += String(chunk)
    const lines = output.split("\n")
    output = lines.pop() ?? ""
    events.push(...lines.map((line) => line.trim()))
  })
  child.stderr.on("data", (chunk) => { errors += String(chunk) })
  let exited = false
  const closed = new Promise<number | null>((resolve) => child.once("close", (code) => {
    exited = true
    resolve(code)
  }))
  child.on("error", (error) => { errors += error.message })
  async function event(name: string, timeout = 15_000) {
    const deadline = performance.now() + timeout
    while (!events.includes(name)) {
      if (exited || performance.now() >= deadline) {
        throw new Error(`Worker ${id} missing ${name}: ${events.join(", ")} ${errors}`)
      }
      await sleep(10)
    }
  }
  async function reap() {
    const deadline = performance.now() + 5_000
    while (!exited) {
      if (performance.now() >= deadline) throw new Error(`Worker ${id} did not exit: ${errors}`)
      await sleep(10)
    }
    return closed
  }
  return {
    child, events, event,
    command() { child.stdin.write("continue\n") },
    async start() { await event("ready"); child.stdin.write("start\n") },
    async done() {
      await event("done")
      if (await reap() !== 0) throw new Error(`Worker ${id} failed: ${errors}`)
    },
    async stop() {
      if (!exited) child.kill("SIGKILL")
      try { await reap() } finally {
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
      }
    },
  }
}
