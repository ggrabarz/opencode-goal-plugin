import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

type PackageJson = {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  devDependencies?: Record<string, string>
}

function readPackageJson() {
  return JSON.parse(readFileSync("package.json", "utf8")) as PackageJson
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function collectRuntimeImports(): string[] {
  const usages: string[] = []
  for (const file of sourceFiles("src")) {
    const text = readFileSync(file, "utf8")
    const transpiler = new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" })
    for (const { path: specifier } of transpiler.scan(text).imports) {
      if (specifier.startsWith("node:") || specifier.startsWith(".")) continue
      usages.push(specifier)
    }
  }
  return usages
}

function matchesDependency(specifier: string, dependency: string) {
  return specifier === dependency || specifier.startsWith(`${dependency}/`)
}

test("runtime imports are covered by dependencies or peerDependencies", () => {
  const packageJson = readPackageJson()
  const dependencies = Object.keys(packageJson.dependencies ?? {})
  const peerDependencies = Object.keys(packageJson.peerDependencies ?? {})

  for (const specifier of collectRuntimeImports()) {
    const covered = [...dependencies, ...peerDependencies].some((dependency) =>
      matchesDependency(specifier, dependency),
    )
    expect({ specifier, covered }).toEqual({ specifier, covered: true })
  }
})

test("declared dependencies are all used at runtime", () => {
  const packageJson = readPackageJson()
  const usages = collectRuntimeImports()

  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    const used = usages.some((specifier) => matchesDependency(specifier, dependency))
    expect({ dependency, used }).toEqual({ dependency, used: true })
  }
})

test("type-only plugin types are not runtime dependencies", () => {
  const packageJson = readPackageJson()
  expect(collectRuntimeImports().some((specifier) => matchesDependency(specifier, "@opencode-ai/plugin"))).toBe(false)
  expect(packageJson.dependencies?.["@opencode-ai/plugin"]).toBeUndefined()
  expect(packageJson.devDependencies?.["@opencode-ai/plugin"]).toBeString()
})

test("host-provided TUI peers are optional so npm does not install them", () => {
  const packageJson = readPackageJson()

  for (const peer of ["@opentui/solid", "solid-js"]) {
    expect(packageJson.peerDependencies?.[peer]).toBeString()
    // The TUI host supplies its own OpenTUI/solid instances. A required peer
    // makes npm install a second copy into the plugin's install tree, which
    // stalls plugin preparation and breaks rendering across two runtimes.
    expect(packageJson.peerDependenciesMeta?.[peer]?.optional).toBe(true)
  }
})
