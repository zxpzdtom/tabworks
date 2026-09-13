import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveConfiguredArgs } from "./config";
import { listResolvedRoutines, loadResolvedRoutine } from "./discovery";
import { format, selectAutoFormat } from "./format";
import { checkPlugins, initLocalPlugin } from "./plugins";
import { bridgeRequestTimeoutMs, callBridgeWithHost, navigationReady } from "./bridge";
import { classifyDaemonState } from "./service";
import { bridgeHost, tabworksPaths } from "./paths";

const originalHome = process.env.TABWORKS_HOME;
const originalTimeout = process.env.TABWORKS_BRIDGE_REQUEST_TIMEOUT_MS;
const tempHomes: string[] = [];

async function tempHome(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "tabworks-test-"));
  tempHomes.push(value);
  process.env.TABWORKS_HOME = value;
  return value;
}

afterEach(async () => {
  if (originalHome === undefined) delete process.env.TABWORKS_HOME;
  else process.env.TABWORKS_HOME = originalHome;
  if (originalTimeout === undefined) delete process.env.TABWORKS_BRIDGE_REQUEST_TIMEOUT_MS;
  else process.env.TABWORKS_BRIDGE_REQUEST_TIMEOUT_MS = originalTimeout;
  await Promise.all(tempHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("配置与 Routine", () => {
  test("用户目录和 Bridge 环境变量均可覆盖", async () => {
    const home = await tempHome();
    const keys = ["TABWORKS_CONFIG_FILE", "TABWORKS_SITES_DIR", "TABWORKS_PLUGINS_DIR", "TABWORKS_BRIDGE_HOST"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.TABWORKS_CONFIG_FILE = join(home, "custom", "config.toml");
      process.env.TABWORKS_SITES_DIR = join(home, "custom-sites");
      process.env.TABWORKS_PLUGINS_DIR = join(home, "custom-plugins");
      process.env.TABWORKS_BRIDGE_HOST = "127.0.0.1:9888";
      const paths = tabworksPaths();
      expect(paths.configFile.endsWith("custom/config.toml")).toBe(true);
      expect(paths.sitesDir.endsWith("custom-sites")).toBe(true);
      expect(paths.pluginsDir.endsWith("custom-plugins")).toBe(true);
      expect(bridgeHost()).toBe("http://127.0.0.1:9888");
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  test("按全局、站点、Routine、命令行顺序合并，并忽略未声明参数", async () => {
    const defs = [
      { name: "limit", type: "int" as const, default: () => 1 },
      { name: "verbose", type: "boolean" as const, default: false },
    ];
    const result = await resolveConfiguredArgs(defs, "shop", "list", { limit: 9 }, {
      limit: 2,
      ignored: "x",
      shop: { limit: 3, verbose: true },
      "shop/list": { limit: 4 },
    });
    expect(result).toEqual({ limit: 9, verbose: true });
    expect("ignored" in result).toBe(false);
    await expect(resolveConfiguredArgs(defs, "shop", "list", {}, { limit: "bad" })).rejects.toThrow("必须为 int");
  });

  test("用户 Routine 覆盖内置 Routine，并支持 object/MJS 和动态元数据", async () => {
    const home = await tempHome();
    const pluginDir = join(home, "plugins", "node_modules", "tabworks-demo-plugin");
    await mkdir(join(pluginDir, "sites", "example"), { recursive: true });
    await writeFile(join(home, "plugins", "package.json"), JSON.stringify({ private: true, dependencies: { "tabworks-demo-plugin": "1.0.0" } }));
    await writeFile(join(pluginDir, "package.json"), JSON.stringify({ name: "tabworks-demo-plugin", version: "1.0.0", tabworks: { sitesDir: "sites", pluginApiVersion: 1 } }));
    await writeFile(join(pluginDir, "sites", "example", "read-title.js"), `export default {
      site: "example", name: "read-title", description: "plugin override", url: "https://example.com",
      risk: "readonly", requiresBrowser: false, async run() { return [{ source: "plugin" }]; }
    };`);
    expect((await loadResolvedRoutine("example", "read-title")).source?.kind).toBe("plugin");

    const dir = join(home, "sites", "example");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "read-title.mjs"), `export default {
      site: "example", name: "read-title", description: "user override", url: "https://example.com",
      risk: "readonly", requiresBrowser: false, navReady: "url",
      resolveRisk(args) { return args.write ? "high" : "readonly"; },
      resolveUrl(args) { return args.url || this.url; },
      args: [{ name: "write", type: "boolean", default: false }, { name: "url", type: "string", default: "https://example.org" }],
      async run(_page, args) { return [{ source: "user", url: args.url }]; }
    };`);
    await writeFile(join(dir, "_ignored.ts"), "throw new Error('must not load')");
    await writeFile(join(dir, "other.test.ts"), "throw new Error('must not load')");
    const routines = await listResolvedRoutines();
    const routine = routines.find((item) => item.site === "example" && item.name === "read-title");
    expect(routine?.source?.kind).toBe("user");
    expect(routine?.requiresBrowser).toBe(false);
    expect(await routine?.resolveRisk({ write: true })).toBe("high");
    expect(await routine?.resolveUrl({ url: "https://dynamic.example" })).toBe("https://dynamic.example");
  });

  test("纯 HTTP Routine 无需 Bridge 即可执行", async () => {
    const home = await tempHome();
    const dir = join(home, "sites", "local");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "ping.js"), `export default {
      site: "local", name: "ping", description: "pure http", url: "https://example.com", risk: "readonly",
      requiresBrowser: false, columns: ["ok"], async run(page) { if (page !== null) throw new Error("browser created"); return [{ ok: true }]; }
    };`);
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "..", "cli", "main.ts"), "local", "ping", "--json"], {
      cwd: tmpdir(),
      env: { ...process.env, TABWORKS_HOME: home, TABWORKS_PORT: "59999" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual([{ ok: true }]);
  });

  test("无效 object Routine 给出明确元数据错误", async () => {
    const home = await tempHome();
    const dir = join(home, "sites", "broken");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "missing.js"), "export default { site: 'broken', name: 'missing' };");
    await expect(loadResolvedRoutine("broken", "missing")).rejects.toThrow("缺少 run(page,args,sdk)");
  });
});

describe("插件与输出", () => {
  test("插件 manifest 会与实际 Routine 一致性校验并实际加载", async () => {
    const home = await tempHome();
    const created = await initLocalPlugin("demo");
    expect((await checkPlugins("demo")).ok).toBe(true);
    const manifest = JSON.parse(await Bun.file(created.manifestFile).text());
    manifest.routines.push("missing");
    await writeFile(created.manifestFile, JSON.stringify(manifest));
    const checked = await checkPlugins("demo");
    expect(checked.ok).toBe(false);
    expect(checked.errors.join("\n")).toContain("missing");
    expect(home).toContain("tabworks-test-");
  });

  test("auto 在窄终端切换列表，URL 永不省略", () => {
    const longUrl = `https://example.com/${"a".repeat(400)}`;
    const rows = [{ title: "x".repeat(400), profileUrl: longUrl }];
    expect(selectAutoFormat(rows, ["title", "profileUrl"], 60)).toBe("list");
    const output = format(rows, "auto", ["title", "profileUrl"]);
    expect(output).toContain(longUrl);
    expect(output).toContain("…");
    expect(JSON.parse(format(rows, "json"))).toEqual(rows);
  });
});

describe("导航、超时与 daemon 恢复", () => {
  test("url 策略只要求非空 HTTP(S)，load 策略要求 complete", () => {
    expect(navigationReady("url", "loading", "https://example.com/app")).toBe(true);
    expect(navigationReady("url", "complete", "data:text/html,blank")).toBe(false);
    expect(navigationReady("load", "interactive", "https://example.com")).toBe(false);
    expect(navigationReady("load", "complete", "https://example.com")).toBe(true);
  });

  test("Bridge 请求超时读取环境变量", () => {
    process.env.TABWORKS_BRIDGE_REQUEST_TIMEOUT_MS = "4321";
    expect(bridgeRequestTimeoutMs()).toBe(4321);
    process.env.TABWORKS_BRIDGE_REQUEST_TIMEOUT_MS = "bad";
    expect(bridgeRequestTimeoutMs()).toBe(30_000);
  });

  test("Bridge HTTP 客户端会实际中止超时请求", async () => {
    process.env.TABWORKS_BRIDGE_REQUEST_TIMEOUT_MS = "15";
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(100);
        return Response.json({ ok: true });
      },
    });
    try {
      await expect(callBridgeWithHost(`http://127.0.0.1:${server.port}`, "/slow")).rejects.toThrow();
    } finally {
      server.stop(true);
    }
  });

  test("daemon 状态可区分残留、可恢复和未知进程", () => {
    const meta = { pid: 10, host: "http://127.0.0.1:9527", port: 9527, startedAt: "now", logFile: "x", entry: "/bridge.mjs" };
    expect(classifyDaemonState(meta, true, true, "/bridge.mjs")).toBe("healthy");
    expect(classifyDaemonState(meta, false, false, "/bridge.mjs")).toBe("stale");
    expect(classifyDaemonState(meta, false, true, "/bridge.mjs")).toBe("recoverable");
    expect(classifyDaemonState(meta, false, true, "/other.mjs")).toBe("unsafe");
  });

  test("ensureBridgeReady 在 daemon 缺失时会后台自启动", async () => {
    const home = await tempHome();
    const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
    const port = String(probe.port);
    probe.stop(true);
    const bridgeModule = pathToFileURL(join(import.meta.dir, "bridge.ts")).href;
    const env = { ...process.env, TABWORKS_HOME: home, TABWORKS_PORT: port, TABWORKS_BRIDGE_HOST: `http://127.0.0.1:${port}` };
    try {
      const started = Bun.spawnSync([
        process.execPath,
        "-e",
        `const m = await import(${JSON.stringify(bridgeModule)}); console.log(JSON.stringify(await m.ensureBridgeReady({autoStart:true,requireExtension:false})));`,
      ], { env, stdout: "pipe", stderr: "pipe" });
      expect(started.exitCode).toBe(0);
      expect(JSON.parse(started.stdout.toString()).ok).toBe(true);
      expect(await Bun.file(join(home, "state", "daemon.json")).exists()).toBe(true);
    } finally {
      Bun.spawnSync([
        process.execPath,
        join(import.meta.dir, "..", "..", "cli", "main.ts"),
        "daemon", "stop", "--port", port,
      ], { env, stdout: "pipe", stderr: "pipe" });
    }
  });
});
