import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getNpmPluginRoots } from "./plugins";
import { ensureTabworksHome } from "./paths";
import { Routine } from "./routine";
import type { Args, ObjectRoutine, Page, Risk, RoutineSource, Row } from "./types";

export interface RoutineCandidate {
  site: string;
  name: string;
  filePath: string;
  source: RoutineSource;
  priority: number;
}

const ROUTINE_EXTENSIONS = new Set([".ts", ".js", ".mjs"]);
const RISKS = new Set<Risk>(["readonly", "low", "medium", "high"]);

function isRoutineFile(name: string): boolean {
  const extension = extname(name);
  if (!ROUTINE_EXTENSIONS.has(extension) || name.startsWith("_") || name.startsWith(".")) return false;
  return !/(?:^|\.)(?:test|spec)(?:\.|$)|\.integration\.test\./i.test(name);
}

async function scanRoot(root: string, source: RoutineSource, priority: number): Promise<RoutineCandidate[]> {
  const candidates: RoutineCandidate[] = [];
  let sites;
  try { sites = await readdir(root, { withFileTypes: true }); } catch { return []; }
  for (const siteEntry of sites.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!siteEntry.isDirectory() || siteEntry.name.startsWith(".") || siteEntry.name.startsWith("_")) continue;
    const siteDir = join(root, siteEntry.name);
    let files;
    try { files = await readdir(siteDir, { withFileTypes: true }); } catch { continue; }
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || !isRoutineFile(file.name)) continue;
      candidates.push({
        site: siteEntry.name,
        name: file.name.slice(0, -extname(file.name).length),
        filePath: join(siteDir, file.name),
        source: { ...source, path: join(siteDir, file.name) },
        priority,
      });
    }
  }
  return candidates;
}

export async function discoverRoutineCandidates(): Promise<RoutineCandidate[]> {
  const paths = await ensureTabworksHome();
  const result: RoutineCandidate[] = [];
  result.push(...await scanRoot(paths.builtinSitesDir, { kind: "builtin", label: "内置", path: paths.builtinSitesDir }, 1));
  for (const plugin of await getNpmPluginRoots()) {
    if (!plugin.pathValid || plugin.pluginApiVersion !== 1) continue;
    result.push(...await scanRoot(plugin.sitesDir, {
      kind: "plugin", label: `npm:${plugin.packageName}`, path: plugin.sitesDir, packageName: plugin.packageName,
    }, 2));
  }
  result.push(...await scanRoot(paths.sitesDir, { kind: "user", label: "用户本地", path: paths.sitesDir }, 3));
  return result;
}

export async function resolvedRoutineCandidates(): Promise<RoutineCandidate[]> {
  const selected = new Map<string, RoutineCandidate>();
  for (const candidate of await discoverRoutineCandidates()) {
    const key = `${candidate.site}/${candidate.name}`;
    const current = selected.get(key);
    if (!current || candidate.priority >= current.priority) selected.set(key, candidate);
  }
  return [...selected.values()].sort((a, b) => `${a.site}/${a.name}`.localeCompare(`${b.site}/${b.name}`));
}

class ObjectRoutineAdapter extends Routine {
  readonly site: string;
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly risk: Risk;
  readonly args;
  readonly columns;
  readonly requiresBrowser;
  readonly navReady;
  readonly navTimeoutMs;
  readonly navOptional;

  constructor(private readonly definition: ObjectRoutine) {
    super();
    this.site = definition.site;
    this.name = definition.name;
    this.description = definition.description;
    this.url = definition.url;
    this.risk = definition.risk;
    this.args = definition.args ?? [];
    this.columns = definition.columns;
    this.requiresBrowser = definition.requiresBrowser ?? true;
    this.navReady = definition.navReady ?? "load";
    this.navTimeoutMs = definition.navTimeoutMs ?? 15_000;
    this.navOptional = definition.navOptional ?? false;
  }

  async run(page: Page, args: Args): Promise<Row[]> {
    return await this.definition.run(page ?? null, args, this.sdk(page ?? null));
  }

  override describeAction(args: Args): string {
    return this.definition.describeAction?.(args) ?? "";
  }

  override resolveRisk(args: Args): Risk | Promise<Risk> {
    return this.definition.resolveRisk?.(args) ?? this.risk;
  }

  override resolveUrl(args: Args): string | Promise<string> {
    return this.definition.resolveUrl?.(args) ?? this.url;
  }
}

function validateRoutine(routine: Routine, candidate: RoutineCandidate): void {
  const prefix = `${candidate.filePath}`;
  for (const key of ["site", "name", "description", "url"] as const) {
    if (typeof routine[key] !== "string" || !routine[key].trim()) throw new Error(`${prefix}: ${key} 必须是非空字符串`);
  }
  if (routine.site !== candidate.site || routine.name !== candidate.name) {
    throw new Error(`${prefix}: 元数据 ${routine.site}/${routine.name} 与目录文件 ${candidate.site}/${candidate.name} 不一致`);
  }
  if (!RISKS.has(routine.risk)) throw new Error(`${prefix}: risk 必须是 readonly|low|medium|high`);
  if (!Array.isArray(routine.args)) throw new Error(`${prefix}: args 必须是数组`);
  const names = new Set<string>();
  for (const def of routine.args) {
    if (!def || typeof def.name !== "string" || !def.name || !["string", "int", "float", "boolean"].includes(def.type)) {
      throw new Error(`${prefix}: args 包含无效参数声明`);
    }
    if (names.has(def.name)) throw new Error(`${prefix}: 参数 ${def.name} 重复声明`);
    names.add(def.name);
  }
  if (routine.columns && (!Array.isArray(routine.columns) || routine.columns.some((value) => typeof value !== "string"))) {
    throw new Error(`${prefix}: columns 必须是字符串数组`);
  }
  if (typeof routine.requiresBrowser !== "boolean") throw new Error(`${prefix}: requiresBrowser 必须是 boolean`);
  if (!["load", "url"].includes(routine.navReady)) throw new Error(`${prefix}: navReady 必须是 load 或 url`);
  if (!Number.isFinite(routine.navTimeoutMs) || routine.navTimeoutMs <= 0) throw new Error(`${prefix}: navTimeoutMs 必须是正数`);
  if (typeof routine.navOptional !== "boolean") throw new Error(`${prefix}: navOptional 必须是 boolean`);
  if (typeof routine.run !== "function") throw new Error(`${prefix}: 缺少 run(page,args,sdk)`);
}

function pickExport(module: Record<string, unknown>): unknown {
  if (module.default !== undefined) return module.default;
  if (module.routine !== undefined) return module.routine;
  return Object.values(module).find((value) => value && (typeof value === "function" || typeof (value as { run?: unknown }).run === "function"));
}

function validateObjectDefinition(value: Record<string, unknown>, filePath: string): void {
  if (typeof value.run !== "function") throw new Error(`${filePath}: object Routine 缺少 run(page,args,sdk)`);
  for (const key of ["describeAction", "resolveRisk", "resolveUrl"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "function") throw new Error(`${filePath}: ${key} 必须是函数`);
  }
}

export async function loadRoutineCandidate(candidate: RoutineCandidate): Promise<Routine> {
  let module: Record<string, unknown>;
  try {
    const modified = (await stat(candidate.filePath)).mtimeMs;
    module = await import(`${pathToFileURL(candidate.filePath).href}?mtime=${modified}`) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`加载失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const exported = pickExport(module);
  let routine: Routine;
  if (exported instanceof Routine) routine = exported;
  else if (typeof exported === "function") {
    try { routine = new (exported as new () => Routine)(); }
    catch (error) { throw new Error(`class 初始化失败：${error instanceof Error ? error.message : String(error)}`); }
    if (!(routine instanceof Routine)) throw new Error(`${candidate.filePath}: class 必须继承 Routine`);
  } else if (exported && typeof exported === "object") {
    validateObjectDefinition(exported as Record<string, unknown>, candidate.filePath);
    routine = new ObjectRoutineAdapter(exported as ObjectRoutine);
  } else {
    throw new Error(`${candidate.filePath}: 必须导出 Routine class 或 object`);
  }
  validateRoutine(routine, candidate);
  routine.source = candidate.source;
  return routine;
}

export async function loadResolvedRoutine(site: string, name: string): Promise<Routine> {
  const candidate = (await resolvedRoutineCandidates()).find((item) => item.site === site && item.name === name);
  if (!candidate) throw new Error(`找不到 ${site}/${name}`);
  return loadRoutineCandidate(candidate);
}

export async function listResolvedRoutines(): Promise<Routine[]> {
  const result: Routine[] = [];
  const errors: string[] = [];
  for (const candidate of await resolvedRoutineCandidates()) {
    try { result.push(await loadRoutineCandidate(candidate)); }
    catch (error) { errors.push(`${candidate.site}/${candidate.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (errors.length) throw new Error(`Routine 加载失败：\n${errors.map((item) => `- ${item}`).join("\n")}`);
  return result;
}
