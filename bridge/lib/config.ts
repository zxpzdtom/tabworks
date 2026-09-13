import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { ensureTabworksHome } from "./paths";
import type { ArgDef, ArgValue, Args } from "./types";

type ConfigRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ConfigRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateTypedValue(def: ArgDef, value: unknown, origin: string): ArgValue {
  const fail = () => {
    throw new Error(`${origin} 的 ${def.name} 必须为 ${def.type}`);
  };
  switch (def.type) {
    case "string":
      if (typeof value !== "string") return fail();
      return value;
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) return fail();
      return value;
    case "float":
      if (typeof value !== "number" || !Number.isFinite(value)) return fail();
      return value;
    case "boolean":
      if (typeof value !== "boolean") return fail();
      return value;
  }
}

async function runtimeDefault(def: ArgDef): Promise<ArgValue | undefined> {
  if (def.default === undefined) return undefined;
  const value = typeof def.default === "function" ? await def.default() : def.default;
  return validateTypedValue(def, value, `参数 ${def.name} 的默认值`);
}

export async function loadConfig(): Promise<ConfigRecord> {
  const paths = await ensureTabworksHome();
  try {
    return parseToml(await readFile(paths.configFile, "utf8")) as ConfigRecord;
  } catch (error) {
    throw new Error(`无法读取配置 ${paths.configFile}：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function resolveConfiguredArgs(
  defs: ArgDef[],
  site: string,
  routine: string,
  cliArgs: Args,
  configOverride?: ConfigRecord,
): Promise<Args> {
  const config = configOverride ?? await loadConfig();
  const rawSiteValues = config[site];
  const rawRoutineValues = config[`${site}/${routine}`];
  const siteValues: ConfigRecord = isRecord(rawSiteValues) ? rawSiteValues : {};
  const routineValues: ConfigRecord = isRecord(rawRoutineValues) ? rawRoutineValues : {};
  const result: Args = {};

  for (const def of defs) {
    const defaultValue = await runtimeDefault(def);
    if (defaultValue !== undefined) result[def.name] = defaultValue;
    const layers: Array<[unknown, string]> = [
      [isRecord(config[def.name]) ? undefined : config[def.name], "顶层配置"],
      [siteValues[def.name], `[${site}]`],
      [routineValues[def.name], `[${site}/${routine}]`],
      [cliArgs[def.name], "命令行"],
    ];
    for (const [value, origin] of layers) {
      if (value !== undefined) result[def.name] = validateTypedValue(def, value, origin);
    }
    if (def.required && result[def.name] === undefined) {
      throw new Error(`缺少必填参数：--${def.name}`);
    }
  }
  return result;
}
