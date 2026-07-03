/**
 * lib/args.ts — Routine 参数解析
 */

import type { ArgDef, ArgValue, Args, Format } from "./types";

const RESERVED_FLAGS = new Set(["format", "help", "h"]);

function parseBoolean(name: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`参数 --${name} 必须为 boolean：true | false`);
}

function parseValue(def: ArgDef, raw: string): ArgValue {
  switch (def.type) {
    case "string":
      return raw;
    case "int": {
      const value = Number.parseInt(raw, 10);
      if (!Number.isInteger(value)) {
        throw new Error(`参数 --${def.name} 必须为整数`);
      }
      return value;
    }
    case "float": {
      const value = Number.parseFloat(raw);
      if (Number.isNaN(value)) {
        throw new Error(`参数 --${def.name} 必须为数字`);
      }
      return value;
    }
    case "boolean":
      return parseBoolean(def.name, raw);
  }
}

export function parseArgs(defs: ArgDef[], argv: string[]): Args {
  const args: Args = {};
  const defMap = new Map(defs.map((def) => [def.name, def]));

  for (const def of defs) {
    if (def.default !== undefined) {
      args[def.name] = def.default;
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    const name = token.slice(2);
    if (RESERVED_FLAGS.has(name)) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) i++;
      continue;
    }

    const def = defMap.get(name);
    if (!def) {
      throw new Error(`未知参数：--${name}`);
    }

    const next = argv[i + 1];
    if (def.type === "boolean") {
      if (next && !next.startsWith("--")) {
        args[name] = parseValue(def, next);
        i++;
      } else {
        args[name] = true;
      }
      continue;
    }

    if (!next || next.startsWith("--")) {
      throw new Error(`参数 --${name} 需要一个值`);
    }

    args[name] = parseValue(def, next);
    i++;
  }

  for (const def of defs) {
    if (def.required && args[def.name] === undefined) {
      throw new Error(`缺少必填参数：--${def.name}`);
    }
  }

  return args;
}

export function extractFormat(argv: string[]): Format {
  const index = argv.findIndex((arg) => arg === "--format");
  if (index === -1) return "table";

  const raw = argv[index + 1];
  if (!raw || raw.startsWith("--")) {
    throw new Error("参数 --format 需要一个值：table | json");
  }

  if (raw === "table" || raw === "json") return raw;
  throw new Error(`不支持的输出格式：${raw}（仅支持 table | json）`);
}
