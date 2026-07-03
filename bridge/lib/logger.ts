/**
 * lib/logger.ts — 结构化日志
 *
 * 基于 pino，只写文件，不打印到终端：
 *   - 文件：logs/YYYY-MM-DD.jsonl（level >= debug，完整 JSONL）
 *   - logs/ 位于仓库根目录（tabworks/logs/），已 gitignore
 *
 * 用法：
 *   import { rootLogger } from './logger.ts';
 *   const log = rootLogger.child({ site: 'example', routine: 'read-page' });
 *   log.info({ url }, 'fetch start');
 *   log.debug({ code: script.slice(0, 200) }, 'run-js');
 *   log.error({ err }, 'fetch failed');
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";

// ─── 日志目录（仓库根目录下的 logs/）───────────────────────────────

const LOGS_DIR = join(import.meta.dirname, "..", "..", "logs");

try {
  mkdirSync(LOGS_DIR, { recursive: true });
} catch {
  /* 已存在 */
}

export function todayLogFile(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return join(LOGS_DIR, `${y}-${m}-${day}.jsonl`);
}

// ─── pino 实例 ───────────────────────────────────────────────────────

export const rootLogger = pino(
  {
    level: "debug",
    serializers: { err: pino.stdSerializers.err },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  // 只写文件，debug+ 完整 JSONL，跨天重启 bridge 自动切换到新文件
  pino.transport({
    target: "pino/file",
    options: {
      destination: todayLogFile(),
      append: true,
      mkdir: true,
    },
  }),
);
