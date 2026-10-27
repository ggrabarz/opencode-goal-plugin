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
try {
  emit("ready")
  await command()
  if (mode === "before-rename" || mode === "after-rename") {
    const rename = defaultAtomicWriteOps.rename
    defaultAtomicWriteOps.rename = async (from, to) => {
      if (to !== file) return rename(from, to)
      if (mode === "after-rename") await rename(from, to)
      emit(mode)
      await command()
      if (mode === "before-rename") await rename(from, to)
    }
  }
  emit("attempting")
  if (mode === "usage") {
    for (let index = 1; index <= Number(count); index++) {
      await accountUsage("shared", index, { cumulative: true, source: id, initialBaseline: 0 })
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
