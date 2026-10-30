import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createStore, type Store } from "solid-js/store"
import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import plugin, {
  goalFromV2Messages,
  goalStateLines,
  goalStateShortcut,
  goalStatusGlyph,
  GOAL_STATUS_GLYPHS,
  goalTldr,
  liveTimeUsedSeconds,
  readPersistedGoal,
  registerSlotV2,
  setupTuiV2,
  themeColorV2,
  watchGoalStateBinding,
} from "../src/tui.ts"
import { atomicWriteFile } from "../src/atomic-write"
import { messagesFor, resolveLocale } from "../src/i18n"

type GoalSnapshot = Parameters<typeof liveTimeUsedSeconds>[0]

const previousStatePath = process.env.OPENCODE_GOAL_STATE_PATH
const isolatedStateDir = mkdtempSync(join(tmpdir(), "goal-tui-v2-"))
const isolatedStatePath = join(isolatedStateDir, "goals.json")
let hostTheme: ResolvedTheme | undefined

async function writeGoalState(value: unknown) {
  // Use the production atomic writer: replacing an existing file with a
  // rename fails with EPERM on Windows while another reader (the sidebar
  // poller below) still holds the target open, and the writer retries that
  // transient lock instead of failing the test.
  await atomicWriteFile(isolatedStatePath, JSON.stringify(value))
}

beforeAll(async () => {
  process.env.OPENCODE_GOAL_STATE_PATH = isolatedStatePath
  if (process.env.OPENCODE_TEST_HOST_THEME === "1") {
    const { resolvedHostTheme } = await import("./fixtures/host-theme")
    hostTheme = resolvedHostTheme()
  }
})

beforeEach(() => {
  try {
    unlinkSync(isolatedStatePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
})

afterAll(() => {
  if (previousStatePath === undefined) delete process.env.OPENCODE_GOAL_STATE_PATH
  else process.env.OPENCODE_GOAL_STATE_PATH = previousStatePath
  rmSync(isolatedStateDir, { recursive: true, force: true })
})

function goal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    sessionID: "session",
    objective: "test goal",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 10,
    createdAt: 90,
    updatedAt: 100,
    completionEvidence: null,
    blocker: null,
    closedAt: null,
    continuationFailures: 0,
    lastStatus: "Goal set.",
    maxAutoTurns: null,
    maxDurationSeconds: null,
    noProgressTokenThreshold: 50,
    maxNoProgressTurns: 2,
    noProgressTurns: 0,
    budgetWrapupSent: false,
    stopReason: null,
    history: [],
    checkpoints: [],
    lastCheckpoint: null,
    lastAssistantText: "",
    lastAssistantMessageID: "",
    autoTurns: 0,
    lastContinuationAt: null,
    remainingTokens: null,
    sampledAt: 100,
    ...overrides,
  }
}

function assistantMessage(id: string, content: SessionMessageAssistantTool[]): SessionMessageInfo {
  return {
    id,
    time: { created: 0 },
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content,
  } as SessionMessageInfo
}

function goalTool(name: string, text: string): SessionMessageAssistantTool {
  return {
    type: "tool",
    id: `call_${name}`,
    name,
    state: { status: "completed", input: {}, content: [{ type: "text", text }] },
    time: { created: 0 },
  } as SessionMessageAssistantTool
}

function errorTool(name: string): SessionMessageAssistantTool {
  return {
    type: "tool",
    id: `call_${name}`,
    name,
    state: { status: "error", input: {}, error: { type: "error", message: "boom" } },
    time: { created: 0 },
  } as SessionMessageAssistantTool
}

type MockKeymapLayer = {
  mode?: string
  enabled?: boolean | (() => boolean)
  target?: unknown
  priority?: number
  commands?: readonly {
    id?: string
    title?: string
    description?: string
    group?: string
    palette?: true
    bind?: string
    run: (input?: string, event?: unknown) => void | false | Promise<void>
  }[]
  bindings?: readonly string[]
}

type MockContext = {
  options: Record<string, unknown>
  location: undefined
  app: { version: string; channel: string }
  renderer: unknown
  client: {
    session: {
      prompt: (input: { sessionID: string; text: string }) => Promise<unknown>
    }
  }
  data: {
    session: {
      message: { list: (sessionID: string) => SessionMessageInfo[] }
    }
  }
  attention: unknown
  theme: {
    text: Pick<ResolvedTheme["text"], "base" | "muted"> & {
      feedback: Pick<ResolvedTheme["text"]["feedback"], "success">
    }
  }
  markdown: unknown
  keymap: {
    layer: (input: () => MockKeymapLayer) => void
  }
  storage: {
    memory: (
      key: string,
      options: { initial: { goal: GoalSnapshot | null } },
    ) => readonly [
      Store<{ goal: GoalSnapshot | null }>,
      (mutation: (draft: { goal: GoalSnapshot | null }) => void) => void,
    ]
    store: (...args: unknown[]) => never
  }
  ui: {
    dialog: {
      set: (options: { size?: string; centered?: boolean }) => void
      show: (render: () => unknown) => void
      select: (options: { title: string; placeholder: string; options: readonly { title: string; value: string }[] }) => Promise<string | undefined>
      clear: () => void
    }
    toast: {
      show: (options: { title?: string; message: string; variant?: string; duration?: number }) => void
    }
    format: { path: (value: string) => string }
    router: {
      register: () => () => void
      navigate: () => void
      current: () => { type: string; sessionID?: string }
    }
    tabs: unknown
    slot: (options: { append: string; render: (props: { sessionID: string }) => unknown }) => () => void
  }
}

function makeMockContext(overrides: Partial<MockContext> = {}): {
  mock: MockContext
  slots: Map<string, (props: { sessionID: string }) => unknown>
  disposed: string[]
  layers: Array<() => MockKeymapLayer>
  promptCalls: Array<{ sessionID: string; text: string }>
  toasts: Array<{ title?: string; message: string; variant?: string; duration?: number }>
  shown: Array<() => unknown>
  selectCalls: Array<{ title: string; placeholder: string; options: readonly { title: string; value: string }[] }>
  setMessages: (messages: SessionMessageInfo[]) => void
  setRoute: (route: { type: string; sessionID?: string }) => void
} {
  const slots = new Map<string, (props: { sessionID: string }) => unknown>()
  const disposed: string[] = []
  const layers: Array<() => MockKeymapLayer> = []
  const promptCalls: Array<{ sessionID: string; text: string }> = []
  const toasts: Array<{ title?: string; message: string; variant?: string; duration?: number }> = []
  const shown: Array<() => unknown> = []
  const selectCalls: Array<{ title: string; placeholder: string; options: readonly { title: string; value: string }[] }> = []
  const [messages, setMessages] = createSignal<SessionMessageInfo[]>([])
  let route: { type: string; sessionID?: string } = { type: "home" }

  const memories = new Map<string, [Store<{ goal: GoalSnapshot | null }>, (mutation: (draft: { goal: GoalSnapshot | null }) => void) => void]>()

  const mock: MockContext = {
    options: {},
    location: undefined,
    app: { version: "0.0.0", channel: "test" },
    renderer: undefined,
    client: {
      session: {
        async prompt(input) {
          promptCalls.push(input)
          return { id: "pending_1" }
        },
      },
    },
    data: {
      session: {
        message: {
          list() {
            return messages()
          },
        },
      },
    },
    attention: undefined,
    // The host compatibility job uses its real resolved theme. The minimum
    // and forward-compatibility runs share their renderer's native RGBA copy.
    theme: hostTheme ?? {
      text: {
        base: RGBA.fromHex("#e0e0e0"),
        muted: RGBA.fromHex("#808080"),
        feedback: { success: { base: RGBA.fromHex("#00ff00"), muted: RGBA.fromHex("#008800") } },
      },
    },
    markdown: undefined,
    keymap: {
      layer(input) {
        layers.push(input)
      },
    },
    storage: {
      memory(key, options) {
        let entry = memories.get(key)
        if (!entry) {
          const [store, setStore] = createStore<{ goal: GoalSnapshot | null }>({ ...options.initial })
          entry = [
            store,
            (mutation) => {
              const draft = { ...store }
              mutation(draft)
              setStore(draft)
            },
          ]
          memories.set(key, entry)
        }
        return entry
      },
      store() {
        throw new Error("storage.store is not used in these tests")
      },
    },
    ui: {
      dialog: {
        set() {},
        show(render: () => unknown) {
          shown.push(render)
        },
        async select(options) {
          selectCalls.push(options)
          return undefined
        },
        clear() {},
      },
      toast: {
        show(options) {
          toasts.push(options)
        },
      },
      format: { path: (value) => value },
      router: {
        register: () => () => {},
        navigate: () => {},
        current: () => route,
      },
      tabs: undefined,
      // Current previews take a single options argument. Keep the arity at 1 so
      // the plugin exercises the same call shape the real host uses.
      slot(options) {
        slots.set(options.append, options.render)
        return () => {
          disposed.push(options.append)
        }
      },
    },
  }

  return {
    mock: { ...mock, ...overrides },
    slots,
    disposed,
    layers,
    promptCalls,
    toasts,
    shown,
    selectCalls,
    setMessages(next) {
      setMessages(next)
    },
    setRoute(next) {
      route = next
    },
  }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(predicate()).toBe(true)
}

test("V2 TUI definition exposes id and a setup function", () => {
  expect(plugin.id).toBe("local.goal-mode.tui")
  expect(typeof plugin.setup).toBe("function")
  expect(typeof plugin.tui).toBe("function")
})

test("every goal status maps to its own plain text glyph", () => {
  const statuses = [
    "active",
    "paused",
    "budgetLimited",
    "usageLimited",
    "complete",
    "unmet",
    "cancelled",
  ] as const

  expect(Object.keys(GOAL_STATUS_GLYPHS).sort()).toEqual([...statuses].sort())

  const glyphs = statuses.map((status) => goalStatusGlyph(status))
  // One status, one glyph: no two statuses may share an icon.
  expect(new Set(glyphs).size).toBe(statuses.length)
  for (const glyph of glyphs) {
    expect([...glyph]).toHaveLength(1)
    // Below the emoji planes: every glyph is a plain text character, so no
    // font without emoji support renders a placeholder box.
    expect(glyph.codePointAt(0)!).toBeLessThan(0x1f000)
  }

  expect(GOAL_STATUS_GLYPHS.active.codePointAt(0)).toBe(0x25b6)
  expect(GOAL_STATUS_GLYPHS.paused.codePointAt(0)).toBe(0x2016)
  expect(GOAL_STATUS_GLYPHS.budgetLimited.codePointAt(0)).toBe(0x26a0)
  expect(GOAL_STATUS_GLYPHS.usageLimited.codePointAt(0)).toBe(0x231b)
  expect(GOAL_STATUS_GLYPHS.complete.codePointAt(0)).toBe(0x2713)
  expect(GOAL_STATUS_GLYPHS.unmet.codePointAt(0)).toBe(0x2717)
  expect(GOAL_STATUS_GLYPHS.cancelled.codePointAt(0)).toBe(0x2297)
})

test("the shared goal state lines carry the state the sidebar shows", () => {
  const messages = messagesFor(resolveLocale("en"))
  const locale = resolveLocale("en")

  const lines = goalStateLines(
    goal({
      objective: "ship the milestone",
      status: "paused",
      tokensUsed: 42,
      autoTurns: 3,
      maxAutoTurns: 9,
      lastStatus: "Goal paused.",
      lastCheckpoint: { summary: "parser verified", timestamp: 101 },
    }),
    messages,
    locale,
    100,
  )

  expect(lines.map((line) => line.text)).toEqual([
    "Goal",
    "Status: paused",
    "Time: 0:10",
    "Tokens: 42",
    "Auto-continues: 3/9",
    "Checkpoint: parser verified",
    "Goal paused.",
    "ship the milestone",
  ])
})

test("the shared goal state lines collapse a closed goal into its badge", () => {
  const messages = messagesFor(resolveLocale("en"))
  const locale = resolveLocale("en")

  const complete = goalStateLines(
    goal({ status: "complete", timeUsedSeconds: 65, sampledAt: 100 }),
    messages,
    locale,
    100,
  )
  expect(complete).toHaveLength(1)
  expect(complete[0]?.kind).toBe("badge")
  expect(complete[0]?.text).toBe("Goal achieved (1:05)")

  const unmet = goalStateLines(
    goal({ status: "unmet", timeUsedSeconds: 5, sampledAt: 100, blocker: "no access" }),
    messages,
    locale,
    100,
  )
  expect(unmet[0]?.text).toBe("Goal unmet (0:05)")
})

test("registerSlotV2 uses the options argument when the host takes one parameter", () => {
  const calls: Array<{ append: string; render: unknown }> = []
  const context = {
    ui: {
      slot: (options: { append: string; render: () => unknown }) => {
        calls.push(options)
        return () => {}
      },
    },
  }
  const render = () => null

  const dispose = registerSlotV2(context as never, "sidebar.content", render)

  expect(calls).toEqual([{ append: "sidebar.content", render }])
  expect(typeof dispose).toBe("function")
})

test("registerSlotV2 falls back to the positional form on earlier previews", () => {
  const calls: Array<[string, unknown]> = []
  const context = {
    ui: {
      slot: (name: string, render: () => unknown) => {
        calls.push([name, render])
        return () => {}
      },
    },
  }
  const render = () => null

  registerSlotV2(context as never, "app", render)

  expect(calls).toEqual([["app", render]])
})

test("registerSlotV2 tolerates hosts that do not return a disposer", () => {
  const context = { ui: { slot: (_options: { append: string }) => undefined } }

  const dispose = registerSlotV2(context as never, "sidebar.content", () => null)

  expect(typeof dispose).toBe("function")
  expect(() => dispose()).not.toThrow()
})

test("themeColorV2 resolves nested, grouped, and legacy flat theme colors", () => {
  const nested = {
    text: { default: "#ffffff", subdued: "#888888", feedback: { success: { default: "#00ff00" } } },
  }
  const flat = { text: "#eeeeee", textMuted: "#777777", primary: "#00cc00" }

  expect(themeColorV2(nested, ["text", "default"], ["text"])).toBe("#ffffff")
  expect(themeColorV2(nested, ["text", "subdued"], ["textMuted"])).toBe("#888888")
  // A color group resolves to its `default` leaf rather than the group object.
  expect(themeColorV2(nested, ["text", "feedback", "success"], ["primary"])).toBe("#00ff00")

  expect(themeColorV2(flat, ["text", "default"], ["text"])).toBe("#eeeeee")
  expect(themeColorV2(flat, ["text", "subdued"], ["textMuted"])).toBe("#777777")
  expect(themeColorV2(flat, ["text", "feedback", "success"], ["primary"])).toBe("#00cc00")

  expect(themeColorV2({}, ["text", "default"], ["text"])).toBeUndefined()
})

test("V2 setup registers sidebar.content, prompt.footer.status and app slots and cleanup disposes them", () => {
  const { mock, slots, disposed } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)

  expect(slots.has("sidebar.content")).toBe(true)
  expect(slots.has("prompt.footer.status")).toBe(true)
  expect(slots.has("app")).toBe(true)
  expect(disposed).toEqual([])

  cleanup()
  expect(disposed.sort()).toEqual(["app", "prompt.footer.status", "sidebar.content"])
})

test("goalStateShortcut reads the shortcut the host resolved and tolerates a dead keymap", () => {
  expect(goalStateShortcut({ keymap: { shortcuts: () => ["f4"] } })).toEqual(["f4"])
  expect(goalStateShortcut({ keymap: { shortcuts: () => [] } })).toBeNull()
  expect(
    goalStateShortcut({
      keymap: {
        shortcuts: () => {
          throw new Error("keymap unavailable")
        },
      },
    }),
  ).toBeNull()
})

test("watchGoalStateBinding waits for the host to resolve the binding", async () => {
  const resolved: string[] = []
  const unresolved: string[] = []
  let reads = 0
  const stop = watchGoalStateBinding(
    { keymap: { shortcuts: () => (++reads >= 3 ? ["f4"] : []) } },
    { resolved: (message) => resolved.push(message), unresolved: (message) => unresolved.push(message) },
    { timeoutMs: 1000, pollMs: 5 },
  )

  await new Promise((resolve) => setTimeout(resolve, 80))
  stop()

  expect(resolved).toHaveLength(1)
  expect(resolved[0]).toContain("shortcut=f4")
  expect(unresolved).toHaveLength(0)
})

test("watchGoalStateBinding reports a binding the host never resolved", async () => {
  const resolved: string[] = []
  const unresolved: string[] = []
  const stop = watchGoalStateBinding(
    { keymap: { shortcuts: () => [] } },
    { resolved: (message) => resolved.push(message), unresolved: (message) => unresolved.push(message) },
    { timeoutMs: 30, pollMs: 5 },
  )

  await new Promise((resolve) => setTimeout(resolve, 120))
  stop()

  expect(resolved).toHaveLength(0)
  expect(unresolved).toHaveLength(1)
  expect(unresolved[0]).toContain("goal.state")
  expect(unresolved[0]).toContain("no shortcut")
})

test("watchGoalStateBinding stops polling once it has reported", async () => {
  let reads = 0
  const stop = watchGoalStateBinding(
    { keymap: { shortcuts: () => (++reads === 1 ? ["f4"] : []) } },
    { resolved: () => {}, unresolved: () => {} },
    { timeoutMs: 1000, pollMs: 5 },
  )

  await new Promise((resolve) => setTimeout(resolve, 60))
  stop()
  const readsAfterStop = reads
  await new Promise((resolve) => setTimeout(resolve, 40))

  expect(readsAfterStop).toBe(1)
  expect(reads).toBe(readsAfterStop)
})

test("goalFromV2Messages parses the newest completed goal tool output from text ToolContent", () => {
  const snapshot = goal({ status: "paused", objective: "paused goal", lastStatus: "Goal paused." })
  const messages = [
    assistantMessage("created", [goalTool("create_goal", JSON.stringify({ goal: goal({ objective: "first goal" }) }))]),
    assistantMessage("paused", [goalTool("update_goal_status", JSON.stringify({ goal: snapshot }))]),
  ]

  const result = goalFromV2Messages(messages)
  expect(result?.status).toBe("paused")
  expect(result?.objective).toBe("paused goal")
  expect(result?.lastStatus).toBe("Goal paused.")
})

test("goalFromV2Messages ignores non-goal tools, error states, file content, and malformed JSON", () => {
  const snapshot = goal({ objective: "real goal" })
  const messages = [
    assistantMessage("created", [
      goalTool("task", JSON.stringify({ task: "unrelated" })),
      errorTool("create_goal"),
      {
        type: "tool",
        id: "call_get_goal",
        name: "get_goal",
        state: {
          status: "completed",
          input: {},
          content: [
            { type: "file", uri: "file:///tmp/out.json", mime: "application/json" },
            { type: "text", text: JSON.stringify({ goal: snapshot }) },
          ],
        },
        time: { created: 0 },
      } as SessionMessageAssistantTool,
      goalTool("update_goal", "{ not valid json"),
    ]),
  ]

  const result = goalFromV2Messages(messages)
  expect(result?.objective).toBe("real goal")
})

test("goalFromV2Messages returns null after a completed clear_goal", () => {
  const messages = [
    assistantMessage("created", [goalTool("create_goal", JSON.stringify({ goal: goal() }))]),
    assistantMessage("cleared", [goalTool("clear_goal", "")]),
  ]
  expect(goalFromV2Messages(messages)).toBeNull()
})

test("goalFromV2Messages returns undefined when no goal tool output exists", () => {
  expect(goalFromV2Messages([])).toBeUndefined()
  expect(goalFromV2Messages([assistantMessage("plain", [])])).toBeUndefined()
  expect(goalFromV2Messages([{ id: "user", type: "user", time: { created: 0 } } as SessionMessageInfo])).toBeUndefined()
})

test("V2 sidebar renders the parsed goal from session messages", async () => {
  const { mock, slots, setMessages } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  const sidebar = slots.get("sidebar.content")
  expect(sidebar).toBeTypeOf("function")

  setMessages([
    assistantMessage("created", [goalTool("create_goal", JSON.stringify({ goal: goal({ objective: "ship the v2 milestone", status: "paused" }) }))]),
  ])

  const setup = await testRender(() => sidebar?.({ sessionID: "session" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Goal")
    expect(frame).toContain("Status: paused")
    expect(frame).toContain("ship the v2 milestone")
    expect(frame).toContain("Tokens: 0")
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.find((span) => span.text.includes("Goal"))?.fg.equals(mock.theme.text.base)).toBe(true)
    expect(spans.find((span) => span.text.includes("ship the v2 milestone"))?.fg.equals(mock.theme.text.muted)).toBe(true)
    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})

test("V2 sidebar refreshes persisted usage and checkpoint without a new goal tool result", async () => {
  const initial = goal({ objective: "live counters" })
  const { mock, slots, setMessages } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  const sidebar = slots.get("sidebar.content")
  setMessages([assistantMessage("created", [goalTool("create_goal", JSON.stringify({ goal: initial }))])])
  await writeGoalState({ version: 2, goals: { session: { ...initial, lastAccountedAt: 100 } }, archives: {} })

  const setup = await testRender(() => sidebar?.({ sessionID: "session" }) as never, { width: 80, height: 20 })
  try {
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Tokens: 0")

    const updated = goal({
      objective: "live counters",
      tokensUsed: 42,
      autoTurns: 2,
      lastCheckpoint: { summary: "parser verified", timestamp: 101 },
      updatedAt: 101,
    })
    await writeGoalState({ version: 2, goals: { session: { ...updated, lastAccountedAt: 101 } }, archives: {} })

    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await setup.flush()
      const frame = setup.captureCharFrame()
      if (frame.includes("Tokens: 42") && frame.includes("Auto-continues: 2") && frame.includes("parser verified")) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Tokens: 42")
    expect(frame).toContain("Auto-continues: 2")
    expect(frame).toContain("parser verified")
  } finally {
    setup.renderer.destroy()
    cleanup()
  }
})

test("V2 sidebar removes a goal when the persisted session entry is cleared", async () => {
  const initial = goal({ objective: "goal to clear" })
  const { mock, slots, setMessages } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  setMessages([assistantMessage("created", [goalTool("create_goal", JSON.stringify({ goal: initial }))])])
  await writeGoalState({ version: 2, goals: { session: { ...initial, tokensUsed: 1, lastAccountedAt: 100 } }, archives: {} })

  const setup = await testRender(() => slots.get("sidebar.content")?.({ sessionID: "session" }) as never, { width: 80, height: 20 })
  try {
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("goal to clear")
    const initialDeadline = Date.now() + 5000
    while (Date.now() < initialDeadline) {
      await setup.flush()
      if (setup.captureCharFrame().includes("Tokens: 1")) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(setup.captureCharFrame()).toContain("Tokens: 1")
    await writeGoalState({ version: 2, goals: {}, archives: {} })

    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await setup.flush()
      if (!setup.captureCharFrame().includes("goal to clear")) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(setup.captureCharFrame()).not.toContain("goal to clear")
  } finally {
    setup.renderer.destroy()
    cleanup()
  }
})

test("V2 persisted reader distinguishes cleared sessions from unreadable state", async () => {
  await writeFile(isolatedStatePath, JSON.stringify({ version: 2, goals: {}, archives: {} }))
  expect(await readPersistedGoal("session")).toBeNull()
  await writeFile(isolatedStatePath, "{ broken json")
  expect(await readPersistedGoal("session")).toBeUndefined()
  await writeFile(isolatedStatePath, "\0\0\0")
  expect(await readPersistedGoal("session")).toBeUndefined()
})


test("V2 TUI uses zh-CN labels and palette text when locale is configured", async () => {
  const { mock, slots, layers, setMessages } = makeMockContext({ options: { locale: "zh-CN" } })
  const cleanup = setupTuiV2(mock as never)
  const sidebar = slots.get("sidebar.content")
  const app = slots.get("app")
  setMessages([
    assistantMessage("created", [
      goalTool("create_goal", JSON.stringify({ goal: goal({ objective: "完成中文界面", status: "paused" }) })),
    ]),
  ])

  const sidebarRender = await testRender(() => sidebar?.({ sessionID: "session" }) as never, { width: 80, height: 20 })
  const appRender = await testRender(() => app?.({ sessionID: "" }) as never, { width: 80, height: 20 })
  try {
    await sidebarRender.renderOnce()
    await appRender.renderOnce()
    const frame = sidebarRender.captureCharFrame()
    expect(frame).toContain("目标")
    expect(frame).toContain("状态: 已暂停")
    expect(frame).toContain("目标已设置。")
    expect(frame).toContain("完成中文界面")

    const command = layers[0]?.().commands?.find((candidate) => candidate.id === "goal.show")
    expect(command?.title).toBe("目标")
    expect(command?.description).toContain("查看、暂停、继续或清除")
  } finally {
    sidebarRender.renderer.destroy()
    appRender.renderer.destroy()
    cleanup()
  }
})

test("V2 sidebar shows a completion badge for complete goals", async () => {
  const { mock, slots, setMessages } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  const sidebar = slots.get("sidebar.content")

  setMessages([
    assistantMessage("completed", [
      goalTool("update_goal", JSON.stringify({ goal: goal({ status: "complete", completionEvidence: "verified" }) })),
    ]),
  ])

  const setup = await testRender(() => sidebar?.({ sessionID: "session" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Goal achieved")
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.find((span) => span.text.includes("Goal achieved"))?.fg.equals(mock.theme.text.feedback.success.base)).toBe(true)
    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})

test("V2 sidebar reacts when goal tool results arrive after mount", async () => {
  const { mock, slots, setMessages } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  const sidebar = slots.get("sidebar.content")
  const setup = await testRender(() => sidebar?.({ sessionID: "session" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("late goal")

    setMessages([
      assistantMessage("created", [goalTool("create_goal", JSON.stringify({ goal: goal({ objective: "late goal" }) }))]),
    ])
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("late goal")
    expect(setup.captureCharFrame()).toContain("Status: active")

    setMessages([
      assistantMessage("paused", [
        goalTool("update_goal_status", JSON.stringify({ goal: goal({ objective: "late goal", status: "paused" }) })),
      ]),
    ])
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("Status: paused")
    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})

test("V2 keymap layer registers the goal palette command when the app slot renders", async () => {
  const { mock, slots, layers } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  const app = slots.get("app")
  expect(app).toBeTypeOf("function")

  const setup = await testRender(() => app?.({ sessionID: "" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    expect(layers).toHaveLength(1)
    const layer = layers[0]?.()
    const command = layer?.commands?.find((candidate) => candidate.id === "goal.show")
    expect(command).toBeDefined()
    expect(command?.title).toBe("Goal")
    expect(command?.palette).toBe(true)
    // Without an explicit global mode the host never surfaces the command in
    // the palette, even while the layer itself is registered.
    expect(layer?.mode).toBe("global")
    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})

test("V2 palette command prompts the agent through client.session.prompt after dialog.select", async () => {
  const { mock, slots, layers, setMessages, setRoute, selectCalls, promptCalls, toasts } = makeMockContext()
  mock.ui.dialog.select = async (options) => {
    selectCalls.push(options)
    return "resume"
  }
  const cleanup = setupTuiV2(mock as never)
  const app = slots.get("app")
  expect(app).toBeTypeOf("function")

  setMessages([
    assistantMessage("paused", [
      goalTool("update_goal_status", JSON.stringify({ goal: goal({ status: "paused", objective: "resume me" }) })),
    ]),
  ])
  setRoute({ type: "session", sessionID: "ses_v2" })

  const setup = await testRender(() => app?.({ sessionID: "" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    const command = layers[0]?.()?.commands?.find((candidate) => candidate.id === "goal.show")
    expect(command).toBeDefined()
    command?.run()

    await waitFor(() => selectCalls.length === 1)
    expect(selectCalls[0]?.placeholder).toContain("resume me")
    expect(selectCalls[0]?.options.map((option) => option.title)).toEqual(
      expect.arrayContaining(["Refresh", "History", "Resume", "Clear"]),
    )

    await waitFor(() => promptCalls.length === 1)
    expect(promptCalls[0]).toEqual({
      sessionID: "ses_v2",
      text: expect.stringContaining('update_goal_status with status "active"'),
    })
    expect(toasts).toEqual([])

    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})

test("V2 palette command toasts a warning when no session is open", async () => {
  const { mock, slots, layers, toasts, setRoute, selectCalls, promptCalls } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  setRoute({ type: "home" })

  const app = slots.get("app")
  expect(app).toBeTypeOf("function")
  const setup = await testRender(() => app?.({ sessionID: "" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    const command = layers[0]?.()?.commands?.find((candidate) => candidate.id === "goal.show")
    command?.run()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.message).toContain("Open a session")
    expect(toasts[0]?.variant).toBe("warning")
    expect(selectCalls).toHaveLength(0)
    expect(promptCalls).toHaveLength(0)

    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})

test("V2 the input box icon shows the glyph of the goal status", async () => {
  const { mock, slots, setMessages } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  const status = slots.get("prompt.footer.status")
  expect(status).toBeTypeOf("function")
  setMessages([
    assistantMessage("created", [goalTool("create_goal", JSON.stringify({ goal: goal({ status: "paused" }) }))]),
  ])

  const setup = await testRender(() => status?.({ sessionID: "session" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain(goalStatusGlyph("paused"))
    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})

test("V2 the input box icon is empty without a goal", async () => {
  const { mock, slots } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  const status = slots.get("prompt.footer.status")

  const setup = await testRender(() => status?.({ sessionID: "session" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    for (const glyph of Object.values(GOAL_STATUS_GLYPHS)) {
      expect(frame).not.toContain(glyph)
    }
    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})

test("V2 the input box icon follows the goal state in the same cycle as the sidebar", async () => {
  const initial = goal({ objective: "live icon", status: "active" })
  const { mock, slots, setMessages } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  const sidebar = slots.get("sidebar.content")
  const status = slots.get("prompt.footer.status")
  setMessages([
    assistantMessage("created", [goalTool("create_goal", JSON.stringify({ goal: initial }))]),
  ])
  await writeGoalState({
    version: 2,
    goals: { session: { ...initial, status: "paused", lastAccountedAt: 100 } },
    archives: {},
  })

  const sidebarRender = await testRender(() => sidebar?.({ sessionID: "session" }) as never, { width: 80, height: 20 })
  const statusRender = await testRender(() => status?.({ sessionID: "session" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await sidebarRender.renderOnce()
    await statusRender.renderOnce()
    // The persisted state arrives on the poller, so both surfaces pick it up.
    const firstDeadline = Date.now() + 5000
    while (Date.now() < firstDeadline) {
      await sidebarRender.flush()
      await statusRender.flush()
      if (sidebarRender.captureCharFrame().includes("Status: paused")) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    // The icon and the sidebar read the same state, so they show the same status.
    expect(sidebarRender.captureCharFrame()).toContain("Status: paused")
    expect(statusRender.captureCharFrame()).toContain(goalStatusGlyph("paused"))

    const updated = { ...initial, status: "complete" as const, updatedAt: 101 }
    await writeGoalState({
      version: 2,
      goals: { session: { ...updated, lastAccountedAt: 101 } },
      archives: {},
    })

    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await sidebarRender.flush()
      await statusRender.flush()
      if (
        sidebarRender.captureCharFrame().includes("Goal achieved") &&
        statusRender.captureCharFrame().includes(goalStatusGlyph("complete"))
      )
        break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(sidebarRender.captureCharFrame()).toContain("Goal achieved")
    expect(statusRender.captureCharFrame()).toContain(goalStatusGlyph("complete"))
    expect(statusRender.captureCharFrame()).not.toContain(goalStatusGlyph("paused"))

    sidebarRender.renderer.destroy()
    statusRender.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) {
      sidebarRender.renderer.destroy()
      statusRender.renderer.destroy()
    }
    cleanup()
  }
})

test("V2 the goal state popup is bound to a key and shows what the sidebar shows", async () => {
  const { mock, slots, layers, setMessages, setRoute, shown } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  const sidebar = slots.get("sidebar.content")
  const app = slots.get("app")
  setMessages([
    assistantMessage("created", [
      goalTool("create_goal", JSON.stringify({ goal: goal({ objective: "ship the milestone", status: "paused" }) })),
    ]),
  ])
  setRoute({ type: "session", sessionID: "session" })

  const sidebarRender = await testRender(() => sidebar?.({ sessionID: "session" }) as never, { width: 80, height: 20 })
  const appRender = await testRender(() => app?.({ sessionID: "" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await sidebarRender.renderOnce()
    await appRender.renderOnce()
    const frame = sidebarRender.captureCharFrame()

    const command = layers[0]?.()?.commands?.find((candidate) => candidate.id === "goal.state")
    expect(command).toBeDefined()
    // The popup opens from a key, the way the OpenRouter limits plugin opens
    // its popup from f3.
    expect(command?.bind).toBe("f4")
    expect(command?.palette).toBe(true)
    command?.run()

    await waitFor(() => shown.length === 1)
    const popup = await testRender(() => shown[0]?.() as never, { width: 80, height: 20 })
    let popupDestroyed = false
    try {
      await popup.renderOnce()
      const popupFrame = popup.captureCharFrame()
      // Every line of the popup is a line of the sidebar: the popup shows the
      // same state, not a reduced view of it.
      expect(popupFrame).toContain("Status: paused")
      expect(popupFrame).toContain("ship the milestone")
      for (const line of popupFrame.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // The header of the popup and its hint are the popup's own; the state
        // lines below them are the lines of the sidebar.
        if (trimmed === "esc to close") continue
        if (trimmed.startsWith(goalStatusGlyph("paused"))) continue
        if (trimmed.startsWith("TL;DR:")) continue
        // Skip border frame lines (box drawing characters)
        if (/^[┌│└┐┘├┤┬┴┼]/.test(trimmed)) continue
        expect(frame).toContain(trimmed)
      }
      // The status is coloured, the labels are quiet and the values are plain.
      const spans = popup.captureSpans().lines.flatMap((line) => line.spans)
      const statusSpan = spans.find((span) => span.text.includes("paused"))
      expect(statusSpan).toBeDefined()
      const labelSpan = spans.find((span) => span.text.includes("Status:"))
      expect(labelSpan?.fg.equals(mock.theme.text.muted)).toBe(true)
      // The header carries the glyph of the status.
      expect(popupFrame).toContain(goalStatusGlyph("paused"))
      popup.renderer.destroy()
      popupDestroyed = true
    } finally {
      if (!popupDestroyed) popup.renderer.destroy()
    }

    appRender.renderer.destroy()
    sidebarRender.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) {
      appRender.renderer.destroy()
      sidebarRender.renderer.destroy()
    }
    cleanup()
  }
})

test("V2 the goal state popup toasts a warning when no session is open", async () => {
  const { mock, slots, layers, toasts, setRoute, shown } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  setRoute({ type: "home" })
  const app = slots.get("app")

  const setup = await testRender(() => app?.({ sessionID: "" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    const command = layers[0]?.()?.commands?.find((candidate) => candidate.id === "goal.state")
    command?.run()
    await waitFor(() => toasts.length === 1)

    expect(toasts[0]?.message).toContain("Open a session")
    expect(toasts[0]?.variant).toBe("warning")
    expect(shown).toHaveLength(0)

    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})

test("V2 the goal state popup toasts the failure when the dialog cannot be shown", async () => {
  const { mock, slots, layers, setMessages, setRoute, toasts } = makeMockContext()
  mock.ui.dialog.show = () => {
    throw new Error("the popup could not be opened")
  }
  const cleanup = setupTuiV2(mock as never)
  const app = slots.get("app")
  setMessages([
    assistantMessage("created", [goalTool("create_goal", JSON.stringify({ goal: goal({ objective: "popup me" }) }))]),
  ])
  setRoute({ type: "session", sessionID: "session" })

  const setup = await testRender(() => app?.({ sessionID: "" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    const command = layers[0]?.()?.commands?.find((candidate) => candidate.id === "goal.state")
    command?.run()

    await waitFor(() => toasts.length === 1)
    expect(toasts[0]?.message).toContain("the popup could not be opened")

    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})

test("V2 palette command toasts the failure when the dialog cannot be shown", async () => {
  // The command runs detached, so a rejection from the dialog would be an
  // unhandled rejection in the host's TUI process.
  const { mock, slots, layers, setMessages, setRoute, toasts } = makeMockContext()
  mock.ui.dialog.select = async () => {
    throw new Error("the dialog could not be opened")
  }
  const cleanup = setupTuiV2(mock as never)
  const app = slots.get("app")
  expect(app).toBeTypeOf("function")

  setMessages([
    assistantMessage("paused", [
      goalTool("update_goal_status", JSON.stringify({ goal: goal({ status: "paused", objective: "resume me" }) })),
    ]),
  ])
  setRoute({ type: "session", sessionID: "ses_v2" })

  const setup = await testRender(() => app?.({ sessionID: "" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    const command = layers[0]?.()?.commands?.find((candidate) => candidate.id === "goal.show")
    expect(command).toBeDefined()
    command?.run()

    await waitFor(() => toasts.length === 1)
    expect(toasts[0]?.message).toContain("the dialog could not be opened")

    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})

test("goalTldr returns the first sentence of the objective", () => {
  expect(goalTldr(goal({ objective: "Build the parser." }))).toBe("Build the parser.")
  expect(goalTldr(goal({ objective: "Ship the feature! Done." }))).toBe("Ship the feature!")
  expect(goalTldr(goal({ objective: "Fix the bug?" }))).toBe("Fix the bug?")
  // Semicolon is a terminator, so the first sentence ends at the semicolon.
  expect(goalTldr(goal({ objective: "Retry; it should work now." }))).toBe("Retry;")
  expect(goalTldr(goal({ objective: "中文翻译。继续。" }))).toBe("中文翻译。")
})

test("goalTldr caps the result at 160 characters and appends an ellipsis when truncated", () => {
  const long = "a".repeat(200)
  expect(goalTldr(goal({ objective: long }))).toBe(`${"a".repeat(159)}…`)
  const withTerminator = `${"a".repeat(100)}. ${"b".repeat(100)}.`
  expect(goalTldr(goal({ objective: withTerminator }))).toBe(`${"a".repeat(100)}.`)
  // Exactly 160 characters: no truncation.
  const exactly160 = "x".repeat(159) + "."
  expect(goalTldr(goal({ objective: exactly160 })).length).toBe(160)
  expect(goalTldr(goal({ objective: exactly160 }))).toBe(exactly160)
  // 161 characters total: truncated to 159 + ellipsis = 160.
  const tooLong = "x".repeat(160) + "."
  const tooLongTldr = goalTldr(goal({ objective: tooLong }))
  expect(tooLongTldr.length).toBe(160)
  expect(tooLongTldr.endsWith("…")).toBe(true)
})

test("goalTldr collapses multiline objectives into a single sentence", () => {
  const multiline = "First sentence.\n\nSecond sentence.\n\tThird."
  expect(goalTldr(goal({ objective: multiline }))).toBe("First sentence.")
  expect(goalTldr(goal({ objective: "Line one   with   spaces.\nLine two." }))).toBe("Line one with spaces.")
})

test("goalTldr returns an empty string for an empty objective", () => {
  expect(goalTldr(goal({ objective: "" }))).toBe("")
  expect(goalTldr(goal({ objective: "   " }))).toBe("")
})

test("goalTldr returns the trimmed objective when there is no terminator", () => {
  expect(goalTldr(goal({ objective: "no terminator here" }))).toBe("no terminator here")
  expect(goalTldr(goal({ objective: "   spaced   out   " }))).toBe("spaced out")
})

test("the V2 goal state popup contains the TL;DR line", async () => {
  const { mock, slots, layers, setMessages, setRoute, shown } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  const app = slots.get("app")
  setMessages([
    assistantMessage("created", [
      goalTool("create_goal", JSON.stringify({ goal: goal({ objective: "popup tldr goal.\nSecond sentence.", status: "paused" }) })),
    ]),
  ])
  setRoute({ type: "session", sessionID: "session" })

  const setup = await testRender(() => app?.({ sessionID: "" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    const command = layers[0]?.()?.commands?.find((candidate) => candidate.id === "goal.state")
    expect(command).toBeDefined()
    command?.run()

    await waitFor(() => shown.length === 1)
    const popup = await testRender(() => shown[0]?.() as never, { width: 80, height: 20 })
    let popupDestroyed = false
    try {
      await popup.renderOnce()
      const popupFrame = popup.captureCharFrame()
      expect(popupFrame).toContain("TL;DR: popup tldr goal.")
      expect(popupFrame).toContain("popup tldr goal.")
      expect(popupFrame).toContain("Second sentence.")
      popup.renderer.destroy()
      popupDestroyed = true
    } finally {
      if (!popupDestroyed) popup.renderer.destroy()
    }

    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})