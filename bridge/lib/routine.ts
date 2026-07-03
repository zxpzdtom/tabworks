/**
 * lib/routine.ts — Routine 抽象基类
 *
 * 每个站点场景继承此类，只需实现 run() 和声明元数据属性。
 * exec() 封装完整生命周期：检查 bridge → open tab → run → format → close tab。
 *
 * 日志：基类持有一个 pino child logger（this.log），子类可直接用。
 *       pageFetch() 是统一切面，供各站点 xxxFetch() 调用，
 *       自动记录 url、method、requestId、耗时和错误，子类无需手写。
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Logger } from "pino";
import { extractFormat, parseArgs } from "./args";
import { BridgePage, checkBridge, closeTab, openTab } from "./bridge";
import { format } from "./format";
import { rootLogger } from "./logger";
import type { ArgDef, Args, Format, Page, Risk, Row } from "./types";

const SETUP_SH = join(import.meta.dirname, "..", "..", "scripts", "setup.sh");

export abstract class Routine {
  // ─── 子类必须声明的元数据 ──────────────────────────────────────────

  /** 站点 ID，对应 sites/ 下目录名，如 'github'、'dashboard' */
  abstract readonly site: string;

  /** 场景 ID，对应文件名（去掉 .ts），如 'read-page' */
  abstract readonly name: string;

  /** 一句话描述，用于 --list 展示 */
  abstract readonly description: string;

  /** 执行上下文入口 URL，runner 会在此 URL 新建 tab */
  abstract readonly url: string;

  /** 风险等级，影响是否需要二次确认 */
  abstract readonly risk: Risk;

  // ─── 子类可选覆盖 ─────────────────────────────────────────────────

  /** 参数声明，用于解析命令行参数和生成 --help */
  readonly args: ArgDef[] = [];

  /**
   * 输出列声明（有序）。
   * 声明后支持 table 格式；不声明则只输出 json。
   */
  readonly columns?: string[];

  // ─── 核心逻辑（子类实现）─────────────────────────────────────────

  abstract run(page: Page, args: Args): Promise<Row[]>;

  // ─── 日志（子类可用）──────────────────────────────────────────────

  /**
   * pino child logger，绑定 site/routine，子类可直接调用。
   * exec() 开始时初始化，exec() 结束后重置为 null。
   */
  protected log: Logger = rootLogger.child({ site: "unset", routine: "unset" });

  // ─── 生命周期（由 cli/main.ts 调用）───────────────────────────────────

  async exec(argv: string[]): Promise<void> {
    if (argv.includes("--help") || argv.includes("-h")) {
      this.printHelp();
      return;
    }

    const fmt = extractFormat(argv);
    const parsedArgs = parseArgs(this.args, argv);

    // 风险确认
    await this.confirmRisk(parsedArgs);

    // 初始化 child logger，绑定本次执行上下文
    this.log = rootLogger.child({ site: this.site, routine: this.name });
    this.log.info({ argv }, "start");

    const t0 = Date.now();
    let pageId: number | undefined;

    try {
      // 1. 检查 Bridge 连通性，未启动时自动执行 setup.sh
      this.log.debug({}, "check →");
      try {
        await checkBridge();
      } catch {
        process.stderr.write("Bridge 未启动，正在执行 scripts/setup.sh...\n");
        spawnSync("bash", [SETUP_SH], { stdio: "inherit" });
        await checkBridge();
      }
      this.log.debug({ durationMs: Date.now() - t0 }, "check ✓");

      // 2. 打开标签页并等待加载
      this.log.debug({ url: this.url }, "nav →");
      const tNav = Date.now();
      pageId = await openTab(this.url);
      const page = new BridgePage(pageId, this.log);
      await page.waitForLoad();
      this.log.debug({ url: this.url, durationMs: Date.now() - tNav }, "nav ✓");

      // 3. 执行业务逻辑
      this.log.debug({ description: this.description }, "run →");
      const tRun = Date.now();
      const rows = await this.run(page, parsedArgs);
      this.log.debug({ durationMs: Date.now() - tRun }, "run ✓");

      this.log.info(
        { durationMs: Date.now() - t0, rows: rows.length, result: rows },
        "finish",
      );
      console.log(this.formatOutput(rows, fmt));
    } catch (err) {
      this.log.error({ err, durationMs: Date.now() - t0 }, "error");
      throw err;
    } finally {
      // 4. 关闭标签页（仅在 tab 已打开时）
      if (pageId !== undefined) {
        this.log.debug({ url: this.url }, "tab ×");
        await closeTab(pageId);
      }
    }
  }

  // ─── pageFetch — 统一的页面内请求切面 ───────────────────────────
  //
  // 子类直接调用，无需手写 runJs 脚本或日志埋点。
  // 内部自动：
  //   1. 拼装 fetch 脚本并通过 page.runJs 在浏览器上下文执行
  //   2. 记录 fetch →  /  fetch ←  /  fetch ✗ 日志（含 url、headers、body、耗时）
  //
  // 用法：
  //   const data = await this.pageFetch<MyType>(page, {
  //     url: 'https://example.com/api',
  //     method: 'POST',           // 默认 GET
  //     headers: { ... },         // 可选
  //     body: { ... },            // 可选，自动 JSON.stringify
  //     requestId: this.genReqId(), // 可选
  //   });

  protected async pageFetch<T>(
    page: Page,
    options: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      requestId?: string;
    },
  ): Promise<T> {
    const { url, method = "GET", headers, body, requestId } = options;
    const t0 = Date.now();
    const meta = { url, method, headers, body, requestId };

    // 拼装在浏览器上下文执行的 fetch 脚本
    // 加 AbortController 超时（25s），防止页面导航中途脚本被挂住，导致 CDP awaitPromise 永久 pending
    const script = `
      (async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25000);
        try {
          const res = await fetch(${JSON.stringify(url)}, {
            method: ${JSON.stringify(method)},
            credentials: 'include',
            signal: ctrl.signal,
            ${headers ? `headers: ${JSON.stringify(headers)},` : ""}
            ${body !== undefined ? `body: JSON.stringify(${JSON.stringify(body)}),` : ""}
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        } finally {
          clearTimeout(timer);
        }
      })()
    `;

    this.log.debug(meta, "fetch →");
    try {
      const result = await page.runJs<T>(script, { silent: true });
      this.log.debug({ ...meta, durationMs: Date.now() - t0 }, "fetch ←");
      return result;
    } catch (err) {
      this.log.error({ ...meta, durationMs: Date.now() - t0, err }, "fetch ✗");
      throw err;
    }
  }

  // ─── 风险确认 ────────────────────────────────────────────────────

  private async confirmRisk(args: Args): Promise<void> {
    if (this.risk === "readonly" || this.risk === "low") return;

    const detail = this.describeAction(args);

    if (this.risk === "medium") {
      console.log(`\n⚠️  即将执行：${this.description}`);
      if (detail) console.log(`   ${detail}`);
      console.log("   风险等级：medium — 此操作有副作用\n");
      const confirmed = prompt("确认执行？(y/N) ");
      if (confirmed?.toLowerCase() !== "y") {
        console.log("已取消");
        process.exit(0);
      }
    }

    if (this.risk === "high") {
      console.log(`\n🚨 高风险操作：${this.description}`);
      if (detail) console.log(`   ${detail}`);
      console.log("   风险等级：high — 此操作不可逆\n");
      const confirmed = prompt("请输入 yes 确认执行：");
      if (confirmed !== "yes") {
        console.log("已取消");
        process.exit(0);
      }
    }
  }

  /**
   * 子类可覆盖，返回操作详情描述（用于风险确认提示）。
   * 例如：\"将设置切换为 enabled（settingId: 999999）\"
   */
  protected describeAction(_args: Args): string {
    return "";
  }

  // ─── 帮助文本 ────────────────────────────────────────────────────

  printHelp(): void {
    const riskLabel = {
      readonly: "只读",
      low: "低风险",
      medium: "中风险",
      high: "高风险",
    }[this.risk];
    console.log(
      `${this.site}/${this.name} — ${this.description} [${riskLabel}]`,
    );
    console.log(`\n用法：tw ${this.site} ${this.name} [选项]\n`);

    if (this.args.length > 0) {
      console.log("选项：");
      for (const def of this.args) {
        const meta = [
          def.required ? "必填" : "",
          def.default !== undefined ? `默认：${def.default}` : "",
        ]
          .filter(Boolean)
          .join("，");
        console.log(
          `  --${def.name.padEnd(16)} ${def.help ?? ""}${meta ? `（${meta}）` : ""}`,
        );
      }
    }

    console.log(
      `  --${"format".padEnd(16)} 输出格式：table | json（默认：table）`,
    );
    console.log(`  --${"help".padEnd(16)} 显示此帮助`);
  }

  // ─── 输出格式化（子类可覆盖）────────────────────────────────────

  /**
   * 将 run() 返回的 rows 格式化为最终输出字符串。
   * 默认行为：按 this.columns 渲染单张表格。
   * 子类可覆盖此方法实现多分组/多表格输出。
   */
  protected formatOutput(rows: Row[], fmt: Format): string {
    return format(rows, fmt, this.columns);
  }

  // ─── 工具方法（子类可用）─────────────────────────────────────────

  /** 生成符合内网规范的 requestId：[A-F0-9]{32}|{毫秒时间戳} */
  protected genReqId(): string {
    const hex = Array.from(
      { length: 32 },
      () => "0123456789ABCDEF"[Math.floor(Math.random() * 16)],
    ).join("");
    return `${hex}|${Date.now()}`;
  }
}
