import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const PROJECT_DIR = join(import.meta.dir, "..", "..");

function envPath(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

export function tabworksPaths() {
  const home = envPath("TABWORKS_HOME", join(homedir(), ".tabworks"));
  const configFile = envPath("TABWORKS_CONFIG_FILE", join(home, "config.toml"));
  const sitesDir = envPath("TABWORKS_SITES_DIR", join(home, "sites"));
  const pluginsDir = envPath("TABWORKS_PLUGINS_DIR", join(home, "plugins"));
  const stateDir = join(home, "state");
  const logsDir = join(home, "logs");
  return {
    home,
    configFile,
    sitesDir,
    pluginsDir,
    stateDir,
    daemonFile: join(stateDir, "daemon.json"),
    logsDir,
    daemonLogFile: join(logsDir, "daemon.log"),
    screenshotsDir: join(logsDir, "screenshots"),
    exploreDir: join(home, "explore"),
    recordDir: join(home, "record"),
    uiRecordingsDir: join(home, "ui-record"),
    builtinSitesDir: join(PROJECT_DIR, "bridge", "sites"),
    viewerDistDir: join(PROJECT_DIR, "viewer", "dist"),
    bridgeEntry: join(PROJECT_DIR, "bridge", "scripts", "browser-bridge.mjs"),
  };
}

const DEFAULT_CONFIG = `# TabWorks CLI defaults
# Primitive top-level values apply to every Routine that declares the argument.
# [example]
# language = "zh-CN"
# ["example/read-title"]
# verbose = true
`;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureTabworksHome(): Promise<ReturnType<typeof tabworksPaths>> {
  const paths = tabworksPaths();
  await Promise.all([
    mkdir(paths.home, { recursive: true }),
    mkdir(paths.sitesDir, { recursive: true }),
    mkdir(paths.pluginsDir, { recursive: true }),
    mkdir(paths.stateDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.screenshotsDir, { recursive: true }),
    mkdir(paths.exploreDir, { recursive: true }),
    mkdir(paths.recordDir, { recursive: true }),
    mkdir(paths.uiRecordingsDir, { recursive: true }),
  ]);
  if (!(await exists(paths.configFile))) {
    await mkdir(join(paths.configFile, ".."), { recursive: true });
    await writeFile(paths.configFile, DEFAULT_CONFIG, "utf8");
  }
  const packageFile = join(paths.pluginsDir, "package.json");
  if (!(await exists(packageFile))) {
    await writeFile(
      packageFile,
      `${JSON.stringify({ name: "tabworks-managed-plugins", private: true, dependencies: {} }, null, 2)}\n`,
      "utf8",
    );
  }
  return paths;
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function bridgePort(override?: string): string {
  return override ?? (process.env.TABWORKS_PORT?.trim() || "9527");
}

export function bridgeHost(overridePort?: string): string {
  const configured = process.env.TABWORKS_BRIDGE_HOST?.trim();
  if (configured) {
    return /^https?:\/\//i.test(configured)
      ? configured.replace(/\/$/, "")
      : `http://${configured.replace(/\/$/, "")}`;
  }
  return `http://127.0.0.1:${bridgePort(overridePort)}`;
}
