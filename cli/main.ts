#!/usr/bin/env bun

import { Command } from "commander";
import {
  executeClean,
  executeExplore,
  executeRecord,
  executeRoutine,
  executeSynthesize,
  executeUiRecord,
  formatRoutineList,
  listRoutines,
  loadRoutine,
} from "../bridge/lib/cli";
import {
  showBridgeDaemonStatus,
  showBridgeStatus,
  startBridgeDaemon,
  startBridgeService,
  stopBridgeDaemon,
  stopBridgeService,
} from "../bridge/lib/service";
import { doctorReport, extensionStatusReport, formatDoctor } from "../bridge/lib/doctor";
import {
  checkPlugins,
  initLocalPlugin,
  installPlugin,
  listPluginDescriptors,
  uninstallPlugin,
  updateCheckPlugin,
  updatePlugin,
} from "../bridge/lib/plugins";

const BUILTIN_COMMANDS = new Set([
  "list", "serve", "start", "bridge", "daemon", "run", "explore", "record",
  "ui-record", "synthesize", "clean", "plugin", "doctor", "extension", "help",
]);

function addDynamicHelp(program: Command, routineSummary: string): void {
  program.addHelpText(
    "after",
    `\n直接执行 Routine：\n  tw <site> <name> [--arg value ...]\n\n${routineSummary}`,
  );
}

async function maybeRunRoutineFastPath(argv: string[]): Promise<boolean> {
  let site = "";
  let name = "";
  let rest: string[] = [];

  if (!argv[0] || BUILTIN_COMMANDS.has(argv[0]) || argv[0].startsWith("-")) return false;
  {
    if (argv.length === 1 || argv.slice(1).every((item) => item === "--json")) {
      const routines = (await listRoutines()).filter((item) => item.site === argv[0]);
      if (!routines.length) return false;
      console.log(formatRoutineList(routines, argv.includes("--json")));
      return true;
    }
    if (argv.length < 2) return false;
    [site, name, ...rest] = argv;
  }

  const routines = await listRoutines();
  const routine = routines.find(
    (item) => item.site === site && item.name === name,
  );
  if (!routine) return false;

  if (rest.includes("--help") || rest.includes("-h")) {
    await executeRoutine(site, name, ["--help"]);
    return true;
  }

  await executeRoutine(site, name, rest);
  return true;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (await maybeRunRoutineFastPath(argv)) return;

  let routineSummary = "运行 tw list 查看全部能力";
  try { routineSummary = formatRoutineList(await listRoutines()); } catch { /* 诊断命令仍应可运行 */ }
  const program = new Command();

  program
    .name("tw")
    .description("TabWorks Bridge CLI，管理本地 bridge、日志面板和自动化 routine")
    .version("1.1.0")
    .showHelpAfterError();

  addDynamicHelp(program, routineSummary);

  program
    .command("list")
    .description("列出所有可用 Routine")
    .option("--site <site>", "仅列出指定站点")
    .option("--json", "JSON 输出")
    .action(async (opts: { site?: string; json?: boolean }) => {
      const routines = (await listRoutines()).filter((item) => !opts.site || item.site === opts.site);
      console.log(formatRoutineList(routines, opts.json === true));
    });

  program
    .command("doctor")
    .description("检查运行时、用户目录、Routine、daemon、Bridge、扩展和 Viewer")
    .option("--json", "JSON 输出")
    .action(async (opts: { json?: boolean }) => {
      const report = await doctorReport();
      console.log(opts.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
    });

  const extension = program.command("extension").description("Chrome 扩展状态");
  extension.command("status").option("--json", "JSON 输出").action(async (opts: { json?: boolean }) => {
    const report = await extensionStatusReport();
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else {
      const bridge = report.bridge as Record<string, unknown>;
      console.log(`Bridge: ${bridge.running ? "运行中" : "未运行"} (${bridge.host})`);
      console.log(`扩展: ${bridge.extensionConnected ? `已连接 v${bridge.extensionVersion ?? "unknown"}` : bridge.socketConnected ? "连接无健康响应" : "未连接"}`);
      console.log(`最后响应: ${bridge.lastExtensionResponseAt ?? "无"}`);
    }
  });

  const plugin = program.command("plugin").description("本地站点与 npm 插件管理");
  plugin.command("init").argument("<site>").option("--title <title>").option("--description <text>").option("--version <version>").option("--json", "JSON 输出")
    .action(async (site: string, opts: { title?: string; description?: string; version?: string; json?: boolean }) => {
      const result = await initLocalPlugin(site, opts);
      console.log(opts.json ? JSON.stringify(result, null, 2) : `已创建 ${site}\nmanifest: ${result.manifestFile}\nroutine: ${result.routineFile}`);
    });
  plugin.command("list").option("--json", "JSON 输出").action(async (opts: { json?: boolean }) => {
    const result = await listPluginDescriptors();
    console.log(opts.json ? JSON.stringify(result, null, 2) : result.length ? result.map((item) => `${item.type}: ${item.site ?? item.packageName} (${item.path ?? item.sitesDir})`).join("\n") : "暂无插件");
  });
  plugin.command("check").argument("[target]").option("--json", "JSON 输出").action(async (target: string | undefined, opts: { json?: boolean }) => {
    const result = await checkPlugins(target);
    console.log(opts.json ? JSON.stringify(result, null, 2) : [result.ok ? "插件检查通过" : "插件检查失败", ...result.errors.map((error) => `- ${error}`)].join("\n"));
    if (!result.ok) process.exitCode = 1;
  });
  plugin.command("install").argument("<specifier>").action(async (specifier: string) => console.log(await installPlugin(specifier)));
  plugin.command("uninstall").argument("<package>").action(async (name: string) => console.log(await uninstallPlugin(name)));
  plugin.command("update-check").argument("[package]").option("--json", "JSON 输出").action(async (name: string | undefined, opts: { json?: boolean }) => {
    const result = await updateCheckPlugin(name);
    console.log(opts.json ? JSON.stringify(result, null, 2) : result.output);
  });
  plugin.command("update").argument("[package]").action(async (name?: string) => console.log(await updatePlugin(name)));

  program
    .command("serve")
    .alias("start")
    .description("启动统一服务（viewer / 日志 API / bridge / WebSocket）")
    .option("--port <port>", "覆盖默认端口（默认 9527）")
    .action(async (opts: { port?: string }) => {
      await startBridgeService(opts.port);
    });

  const bridge = program.command("bridge").description("bridge 服务管理");

  bridge
    .command("start")
    .description("启动统一 bridge 服务")
    .option("--port <port>", "覆盖默认端口（默认 9527）")
    .action(async (opts: { port?: string }) => {
      await startBridgeService(opts.port);
    });

  bridge
    .command("stop")
    .description("停止 bridge 服务")
    .option("--port <port>", "指定端口（默认 9527）")
    .action(async (opts: { port?: string }) => {
      await stopBridgeService(opts.port);
    });

  bridge
    .command("status")
    .description("查看 bridge 连接状态")
    .option("--json", "JSON 输出")
    .option("--port <port>", "指定端口（默认 9527）")
    .action(async (opts: { json?: boolean; port?: string }) => {
      await showBridgeStatus(opts.json === true, opts.port);
    });

  const daemon = program.command("daemon").description("后台常驻服务管理");

  daemon
    .command("start")
    .description("后台常驻启动统一服务")
    .option("--port <port>", "覆盖默认端口（默认 9527）")
    .action(async (opts: { port?: string }) => {
      await startBridgeDaemon(opts.port);
    });

  daemon
    .command("stop")
    .description("停止后台常驻服务")
    .option("--port <port>", "指定端口（默认 9527）")
    .action(async (opts: { port?: string }) => {
      await stopBridgeDaemon(opts.port);
    });

  daemon
    .command("status")
    .description("查看后台常驻服务状态")
    .option("--json", "JSON 输出")
    .option("--port <port>", "指定端口（默认 9527）")
    .action(async (opts: { json?: boolean; port?: string }) => {
      await showBridgeDaemonStatus(opts.json === true, opts.port);
    });

  program
    .command("run")
    .description("执行指定 Routine")
    .argument("<site>", "站点 ID")
    .argument("<name>", "routine 名称")
    .argument("[args...]", "透传给 routine 的参数")
    .allowUnknownOption(true)
    .action(async (site: string, name: string, args: string[] = []) => {
      await executeRoutine(site, name, args);
    });

  program
    .command("explore")
    .description("探索站点页面，分析能力实现方式")
    .requiredOption("--url <url>", "页面 URL")
    .requiredOption("--site <site>", "站点名")
    .option("--name <name>", "能力名")
    .option("--wait <ms>", "等待毫秒", "3000")
    .action(async (opts) => {
      const args = [
        "--url",
        opts.url,
        "--site",
        opts.site,
        "--wait",
        opts.wait,
      ];
      if (opts.name) args.push("--name", opts.name);
      console.log(await executeExplore(args));
    });

  program
    .command("record")
    .description("交互式录制：打开页面，捕获用户操作期间的 API 请求，分析推断能力")
    .argument("[url]", "页面 URL")
    .option("--url <url>", "页面 URL（兼容旧写法）")
    .option("--site <site>", "站点名（默认从 URL 推断，特殊站点可覆盖）")
    .option("--name <name>", "能力名（默认从接口自动推断）")
    .option("--timeout <seconds>", "录制超时秒数", "120")
    .action(async (url: string | undefined, opts) => {
      const args = [];
      if (url) args.push(url);
      if (opts.url) args.push("--url", opts.url);
      if (opts.site) args.push("--site", opts.site);
      if (opts.name) args.push("--name", opts.name);
      args.push("--timeout", opts.timeout);
      console.log(await executeRecord(args));
    });

  program
    .command("ui-record")
    .description("录制当前网页 UI 操作，生成后续可导出的 UI 流程数据")
    .argument("<op>", "start | stop | status")
    .argument("[sessionId]", "停止录制时传入的 sessionId")
    .option("--tab-id <id>", "录制指定 Chrome 标签页，默认当前活动标签页")
    .action(async (op: string, sessionId: string | undefined, opts) => {
      const args = [op];
      if (sessionId) args.push(sessionId);
      if (opts.tabId) args.push("--tab-id", opts.tabId);
      console.log(await executeUiRecord(args));
    });

  program
    .command("synthesize")
    .description("从 explore 产物生成 routine 初稿")
    .requiredOption("--site <site>", "站点名")
    .option("--capability <capability>", "能力名")
    .action(async (opts) => {
      const args = ["--site", opts.site];
      if (opts.capability) args.push("--capability", opts.capability);
      console.log(await executeSynthesize(args));
    });

  program
    .command("clean")
    .description("清理 explore 产物")
    .option("--site <site>", "仅清理指定站点")
    .option("--days <days>", "保留最近 N 天，默认 7", "7")
    .action(async (opts) => {
      const args = ["--days", opts.days];
      if (opts.site) args.push("--site", opts.site);
      console.log(await executeClean(args));
    });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  console.error(`错误：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
