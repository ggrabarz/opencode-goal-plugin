import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const suiteStateDir = mkdtempSync(join(tmpdir(), "opencode-goal-plugin-suite-"))
export const suiteStatePath = join(suiteStateDir, "goals.json")

// Keep both resolution paths isolated even after a fixture removes its override.
process.env.XDG_DATA_HOME = join(suiteStateDir, "data")
process.env.OPENCODE_GOAL_STATE_PATH = suiteStatePath

process.on("exit", () => {
  rmSync(suiteStateDir, { recursive: true, force: true })
})
