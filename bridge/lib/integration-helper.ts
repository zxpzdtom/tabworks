/**
 * sites/_integration-helper.ts — 集成测试共享工具
 *
 * 提供：
 *   - isBridgeReady()   检测 bridge + 扩展是否在线
 *   - makePage()        创建真实 BridgePage（自动开/关 tab）
 *   - skipIfOffline()   bridge 离线时自动 skip 当前 test
 *
 * 用法（在各集成测试中）：
 *   import { skipIfOffline, makePage } from '../_integration-helper.ts';
 *
 *   test('real query', async () => {
 *     const { page, cleanup } = await skipIfOffline(MyRoutineUrl);
 *     try {
 *       const rows = await routine.run(page, args);
 *       expect(rows.length).toBeGreaterThan(0);
 *     } finally {
 *       await cleanup();
 *     }
 *   });
 */

import { BridgePage, checkBridge, closeTab, openTab } from "../lib/bridge";
import type { Page } from "../lib/types";

const DEFAULT_BRIDGE_PORT = process.env.TABWORKS_PORT || "9527";
const BRIDGE_HOST =
  process.env.TABWORKS_BRIDGE_HOST ??
  `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}`;

async function resolveBridgeHost(): Promise<string> {
  return BRIDGE_HOST;
}

/** 检测 bridge 是否在线且扩展已连接 */
export async function isBridgeReady(): Promise<boolean> {
  try {
    const bridgeHost = await resolveBridgeHost();
    const res = await fetch(`${bridgeHost}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    const json = (await res.json()) as {
      ok: boolean;
      extensionConnected: boolean;
    };
    return json.ok && json.extensionConnected;
  } catch {
    return false;
  }
}

/** 打开一个真实 tab，返回 Page 和对应的 cleanup */
export async function makePage(
  url: string,
): Promise<{ page: Page; cleanup: () => Promise<void> }> {
  const pageId = await openTab(url);
  const page = new BridgePage(pageId);
  await page.waitForLoad(15000);
  return {
    page,
    cleanup: () => closeTab(pageId),
  };
}

/**
 * 在集成测试 test() 体最开始调用。
 * bridge 离线时打印提示并直接 return，让 bun test 把这个 test 标记为 skip。
 * 在线时返回 { page, cleanup }。
 */
export async function skipIfOffline(
  url: string,
): Promise<{ page: Page; cleanup: () => Promise<void> } | null> {
  const ready = await isBridgeReady();
  if (!ready) {
    console.log("  [skip] bridge 未就绪，跳过集成测试（启动 bridge 后可运行）");
    return null;
  }
  await checkBridge();
  return makePage(url);
}
