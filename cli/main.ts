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

function renderRoutineHelp(routine: Awaited<ReturnType<typeof loadRoutine>>) {
  const riskLabel = {
    readonly: "只读",
    low: "低风险",
    medium: "中风险",
    high: "高风险",
  }[routine.risk];

  const lines = [
    "",
    `站点：${routine.site}`,
    `描述：${routine.description}`,
    `风险：${riskLabel}`,
    `入口：${routine.url}`,
  ];

  if (routine.args.length > 0) {
    lines.push("", "Routine 选项：");
    for (const arg of routine.args) {
      const parts = [
        arg.help ?? "",
        arg.required ? "必填" : "",
        arg.default !== undefined ? `默认：${arg.default}` : "",
      ].filter(Boolean);
      lines.push(
        `  --${arg.name.padEnd(16)} ${parts.join("，")}${parts.length ? "" : "无说明"}`,
      );
    }
  }

  lines.push(
    "",
    `示例：tw ${routine.site} ${routine.name}${
      routine.args[0] ? ` --${routine.args[0].name} <value>` : ""
    }`,
  );
  return lines.join("\n");
}

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

  if (argv[0] === "run") {
    if (argv.length < 3) return false;
    [site, name, ...rest] = argv.slice(1);
  } else {
    if (argv.length < 2) return false;
    [site, name, ...rest] = argv;
  }

  const routines = await listRoutines();
  const routine = routines.find(
    (item) => item.site === site && item.name === name,
  );
  if (!routine) return false;

  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(renderRoutineHelp(routine));
    await executeRoutine(site, name, ["--help"]);
    return true;
  }

  await executeRoutine(site, name, rest);
  return true;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (await maybeRunRoutineFastPath(argv)) return;

  const routineSummary = formatRoutineList(await listRoutines());
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
    .action(async () => {
      console.log(formatRoutineList(await listRoutines()));
    });

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
