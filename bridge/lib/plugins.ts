import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureTabworksHome, readJsonFile, tabworksPaths } from "./paths";
import type { PluginManifest } from "./types";

export const PLUGIN_API_VERSION = 1;
export const LOCAL_MANIFEST_NAMES = ["tabworks.json", "manifest.json"];

export interface NpmPluginRoot {
  packageName: string;
  packageDir: string;
  sitesDir: string;
  pluginApiVersion: number;
  version: string;
  pathValid: boolean;
}

function validId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(value);
}

async function firstManifest(dir: string): Promise<{ path: string; manifest: PluginManifest } | null> {
  for (const name of LOCAL_MANIFEST_NAMES) {
    const path = join(dir, name);
    const manifest = await readJsonFile<PluginManifest>(path);
    if (manifest) return { path, manifest };
  }
  return null;
}

export function validateManifest(manifest: unknown, context: string): string[] {
  const errors: string[] = [];
  const item = manifest as Partial<PluginManifest> | null;
  if (!item || typeof item !== "object") return [`${context}: manifest 必须是 JSON 对象`];
  for (const key of ["site", "title", "description", "version"] as const) {
    if (typeof item[key] !== "string" || !item[key]?.trim()) errors.push(`${context}: ${key} 必须是非空字符串`);
  }
  if (item.pluginApiVersion !== PLUGIN_API_VERSION) {
    errors.push(`${context}: pluginApiVersion=${String(item.pluginApiVersion)}，当前仅支持 ${PLUGIN_API_VERSION}`);
  }
  if (!Array.isArray(item.routines) || item.routines.some((name) => typeof name !== "string" || !validId(name))) {
    errors.push(`${context}: routines 必须是合法名称字符串数组`);
  }
  return errors;
}

export async function getNpmPluginRoots(): Promise<NpmPluginRoot[]> {
  const { pluginsDir } = await ensureTabworksHome();
  const hostPackage = await readJsonFile<{ dependencies?: Record<string, string> }>(join(pluginsDir, "package.json"));
  const names = Object.keys(hostPackage?.dependencies ?? {}).sort();
  const result: NpmPluginRoot[] = [];
  for (const packageName of names) {
    const packageDir = join(pluginsDir, "node_modules", ...packageName.split("/"));
    const packageJson = await readJsonFile<{
      version?: string;
      tabworks?: { sitesDir?: string; pluginApiVersion?: number };
    }>(join(packageDir, "package.json"));
    if (!packageJson?.tabworks?.sitesDir) continue;
    const sitesDir = resolve(packageDir, packageJson.tabworks.sitesDir);
    const rel = relative(packageDir, sitesDir);
    result.push({
      packageName,
      packageDir,
      sitesDir,
      pluginApiVersion: Number(packageJson.tabworks.pluginApiVersion),
      version: packageJson.version ?? "unknown",
      pathValid: rel === "" || (!rel.startsWith("..") && rel !== ".."),
    });
  }
  return result;
}

export async function initLocalPlugin(
  site: string,
  options: { title?: string; description?: string; version?: string } = {},
): Promise<{ siteDir: string; manifestFile: string; routineFile: string }> {
  if (!validId(site)) throw new Error("site 只能包含字母、数字、点、下划线和连字符");
  const paths = await ensureTabworksHome();
  const siteDir = join(paths.sitesDir, site);
  const manifestFile = join(siteDir, "tabworks.json");
  const routineFile = join(siteDir, "hello.ts");
  const existing = await firstManifest(siteDir);
  if (existing) throw new Error(`${site} 已存在 manifest：${existing.path}`);
  await mkdir(siteDir, { recursive: true });
  const manifest: PluginManifest = {
    site,
    title: options.title ?? site,
    description: options.description ?? `${site} 的 TabWorks 本地能力`,
    version: options.version ?? "0.1.0",
    pluginApiVersion: PLUGIN_API_VERSION,
    routines: ["hello"],
  };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(
    routineFile,
    `export default {\n  site: ${JSON.stringify(site)},\n  name: "hello",\n  description: "返回本地 Routine 示例结果",\n  url: "https://example.com",\n  risk: "readonly",\n  requiresBrowser: false,\n  columns: ["message"],\n  async run() { return [{ message: "hello from ${site}" }]; },\n};\n`,
    "utf8",
  );
  return { siteDir, manifestFile, routineFile };
}

function runBun(args: string[], cwd: string): string {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "bun 命令失败").trim());
  return (result.stdout || result.stderr || "").trim();
}

export async function installPlugin(specifier: string): Promise<string> {
  const paths = await ensureTabworksHome();
  const beforePackage = await readJsonFile<{ dependencies?: Record<string, string> }>(join(paths.pluginsDir, "package.json"));
  const beforeNames = new Set(Object.keys(beforePackage?.dependencies ?? {}));
  const output = runBun(["add", "--cwd", paths.pluginsDir, specifier], paths.pluginsDir);
  const afterPackage = await readJsonFile<{ dependencies?: Record<string, string> }>(join(paths.pluginsDir, "package.json"));
  const afterNames = Object.keys(afterPackage?.dependencies ?? {});
  const roots = await getNpmPluginRoots();
  const changedNames = afterNames.filter((name) => !beforeNames.has(name) || specifier === name || specifier.startsWith(`${name}@`));
  const valid = roots.some((root) => changedNames.includes(root.packageName));
  if (!valid) {
    for (const name of changedNames.filter((name) => !beforeNames.has(name))) {
      try { runBun(["remove", "--cwd", paths.pluginsDir, name], paths.pluginsDir); } catch { /* keep original validation error */ }
    }
    throw new Error(`已安装 ${specifier}，但 package.json 未声明 tabworks.sitesDir`);
  }
  return output;
}

export async function uninstallPlugin(packageName: string): Promise<string> {
  const paths = await ensureTabworksHome();
  return runBun(["remove", "--cwd", paths.pluginsDir, packageName], paths.pluginsDir);
}

export async function updateCheckPlugin(packageName?: string): Promise<{ output: string; packageName?: string }> {
  const paths = await ensureTabworksHome();
  const hostPackage = await readJsonFile<{ dependencies?: Record<string, string> }>(join(paths.pluginsDir, "package.json"));
  if (Object.keys(hostPackage?.dependencies ?? {}).length === 0) return { output: "没有已安装的 npm 插件", packageName };
  const args = ["outdated", "--cwd", paths.pluginsDir];
  if (packageName) args.push(packageName);
  const result = spawnSync(process.execPath, args, { cwd: paths.pluginsDir, encoding: "utf8" });
  if (![0, 1].includes(result.status ?? 1)) throw new Error((result.stderr || result.stdout).trim());
  const raw = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const meaningful = raw.split("\n").filter((line) => !/^bun outdated v/i.test(line.trim())).join("\n").trim();
  return { output: meaningful || "没有可用更新", packageName };
}

export async function updatePlugin(packageName?: string): Promise<string> {
  const paths = await ensureTabworksHome();
  const args = ["update", "--cwd", paths.pluginsDir];
  if (packageName) args.push(packageName);
  return runBun(args, paths.pluginsDir);
}

export async function listPluginDescriptors(): Promise<Array<Record<string, unknown>>> {
  const paths = await ensureTabworksHome();
  const descriptors: Array<Record<string, unknown>> = [];
  for (const entry of await readdir(paths.sitesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const found = await firstManifest(join(paths.sitesDir, entry.name));
    descriptors.push({ type: "user", site: entry.name, path: join(paths.sitesDir, entry.name), manifest: found?.manifest ?? null });
  }
  for (const root of await getNpmPluginRoots()) {
    descriptors.push({ type: "npm", packageName: root.packageName, version: root.version, sitesDir: root.sitesDir, pluginApiVersion: root.pluginApiVersion });
  }
  return descriptors;
}

export async function checkPlugins(target?: string): Promise<{ ok: boolean; checked: number; errors: string[]; plugins: Array<Record<string, unknown>> }> {
  const paths = await ensureTabworksHome();
  const errors: string[] = [];
  const plugins: Array<Record<string, unknown>> = [];
  const { discoverRoutineCandidates, loadRoutineCandidate } = await import("./discovery");
  const candidates = await discoverRoutineCandidates();

  for (const entry of await readdir(paths.sitesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || (target && entry.name !== target)) continue;
    const siteDir = join(paths.sitesDir, entry.name);
    const found = await firstManifest(siteDir);
    if (!found) {
      errors.push(`${entry.name}: 缺少 tabworks.json`);
      continue;
    }
    const localErrors = validateManifest(found.manifest, found.path);
    if (found.manifest.site !== entry.name) localErrors.push(`${entry.name}: manifest.site 必须与目录名一致`);
    const actual = candidates.filter((item) => item.source.kind === "user" && item.site === entry.name);
    const actualNames = new Set(actual.map((item) => item.name));
    for (const name of found.manifest.routines ?? []) if (!actualNames.has(name)) localErrors.push(`${entry.name}: manifest 声明的 Routine ${name} 不存在`);
    for (const item of actual) {
      if (!(found.manifest.routines ?? []).includes(item.name)) localErrors.push(`${entry.name}: ${item.name} 未在 manifest.routines 声明`);
      try { await loadRoutineCandidate(item); } catch (error) { localErrors.push(`${entry.name}/${item.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    errors.push(...localErrors);
    plugins.push({ type: "user", site: entry.name, manifest: found.manifest, routines: actual.map((item) => item.name), ok: localErrors.length === 0 });
  }

  for (const root of await getNpmPluginRoots()) {
    if (target && root.packageName !== target) continue;
    const localErrors: string[] = [];
    if (root.pluginApiVersion !== PLUGIN_API_VERSION) localErrors.push(`${root.packageName}: pluginApiVersion=${root.pluginApiVersion}，当前仅支持 ${PLUGIN_API_VERSION}`);
    if (!root.pathValid) localErrors.push(`${root.packageName}: sitesDir 不能指向包目录之外`);
    try { await readdir(root.sitesDir); } catch { localErrors.push(`${root.packageName}: sitesDir 不存在：${root.sitesDir}`); }
    const actual = candidates.filter((item) => item.source.packageName === root.packageName);
    for (const item of actual) {
      try { await loadRoutineCandidate(item); } catch (error) { localErrors.push(`${root.packageName}/${item.site}/${item.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    errors.push(...localErrors);
    plugins.push({ type: "npm", packageName: root.packageName, version: root.version, routines: actual.map((item) => `${item.site}/${item.name}`), ok: localErrors.length === 0 });
  }
  if (target && plugins.length === 0) errors.push(`未找到插件或本地站点：${target}`);
  return { ok: errors.length === 0, checked: plugins.length, errors, plugins };
}
