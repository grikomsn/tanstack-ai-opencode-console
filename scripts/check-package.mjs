import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(root, "packages/tanstack-ai-opencode-console");
const packageManifest = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8"),
);
const scratch = mkdtempSync(join(tmpdir(), "tanstack-opencode-consumer-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  const packResult = JSON.parse(
    execFileSync(npm, ["pack", "--json", "--pack-destination", scratch], {
      cwd: packageDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  // npm 12 returns a name-keyed object; npm 10/11 return an array.
  const packed = (
    Array.isArray(packResult) ? packResult : Object.values(packResult)
  )[0];
  assert(packed, "npm pack must produce a tarball");
  const files = new Set(packed.files.map((file) => file.path));
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/byok.js",
    "dist/byok.d.ts",
    "dist/auth.js",
    "dist/auth.d.ts",
  ]) {
    assert(files.has(required), `Tarball missing ${required}`);
  }
  for (const file of files) {
    assert(
      ["package.json", "README.md", "LICENSE"].includes(file) ||
        /^dist\/[a-z-]+\.(?:js|d\.ts)$/.test(file),
      `Unexpected published file: ${file}`,
    );
  }
  const byokSource = readFileSync(join(packageDir, "dist/byok.js"), "utf8");
  assert(
    !/ai-openai|ai-anthropic|ai-gemini|\.\/index/.test(byokSource),
    "BYOK entry must not import inference SDKs",
  );
  const authSource = readFileSync(join(packageDir, "dist/auth.js"), "utf8");
  assert(
    !/ai-openai|ai-anthropic|ai-gemini|\.\/index/.test(authSource),
    "Auth entry must not import inference SDKs",
  );
  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(scratch, packed.filename),
      `@tanstack/ai@${packageManifest.devDependencies["@tanstack/ai"]}`,
    ],
    {
      cwd: scratch,
      stdio: "inherit",
    },
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { opencodeConsoleText, createOpenCodeConsole, resolveOpenCodeConsoleApi } from 'tanstack-ai-opencode-console';
    import { opencodeConsoleByok } from 'tanstack-ai-opencode-console/byok';
    import { createOpenCodeConsoleSessionAuth, requestOpenCodeConsoleDeviceCode } from 'tanstack-ai-opencode-console/auth';
    assert.equal(typeof createOpenCodeConsoleSessionAuth, 'function');
    assert.equal(typeof requestOpenCodeConsoleDeviceCode, 'function');
    assert.equal(opencodeConsoleByok.id, 'opencode-console');
    assert.equal(createOpenCodeConsole()('big-pickle').name, 'opencode-console');
    for (const model of ['big-pickle', 'gpt-5.5', 'claude-sonnet-4-6', 'gemini-3.1-pro']) {
      const adapter = opencodeConsoleText(model, { apiKey: '' });
      assert.equal(adapter.api, resolveOpenCodeConsoleApi(model));
      assert.equal(adapter.model, model);
    }
  `,
    ],
    { cwd: scratch, stdio: "inherit" },
  );
  writeFileSync(
    join(scratch, "consumer.ts"),
    `
import { chat } from "@tanstack/ai";
import { opencodeConsoleText, createOpenCodeConsole, type OpenCodeConsoleModel } from "tanstack-ai-opencode-console";
import { opencodeConsoleByok } from "tanstack-ai-opencode-console/byok";
import { createOpenCodeConsoleSessionAuth, type OpenCodeConsoleSession } from "tanstack-ai-opencode-console/auth";
declare const consoleSession: OpenCodeConsoleSession;
const sessionAuth = createOpenCodeConsoleSessionAuth(consoleSession);
const sessionAdapter = opencodeConsoleText("gpt-5-nano", {session: sessionAuth});
const adapter = opencodeConsoleText("gpt-5.5", { apiKey: "", inputModalities: ["text", "image"] as const });
const exactModel: "gpt-5.5" = adapter.model;
const visionProvider = createOpenCodeConsole({ inputModalities: ["text", "image"] as const });
const vision = visionProvider("vision-model");
const inheritedModalities: readonly ["text", "image"] = vision["~types"].inputModalities;
const textOnly = visionProvider("text-model", { inputModalities: ["text"] as const });
const overriddenModalities: readonly ["text"] = textOnly["~types"].inputModalities;
const text = chat({ adapter, messages: [{ role: "user", content: "Hello" }], modelOptions: { max_output_tokens: 32 } });
const models: Promise<OpenCodeConsoleModel[]> = createOpenCodeConsole().listModels();
void [exactModel, text, models, opencodeConsoleByok, inheritedModalities, overriddenModalities, sessionAdapter];
`,
  );
  writeFileSync(
    join(scratch, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        lib: ["ES2022", "DOM", "DOM.Iterable"],
      },
      include: ["consumer.ts"],
    }),
  );
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--project",
      join(scratch, "tsconfig.json"),
    ],
    {
      cwd: scratch,
      stdio: "inherit",
    },
  );
  console.log(
    `Package verified: ${packed.name}@${packed.version}, ${files.size} published files; isolated imports and public types passed.`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
