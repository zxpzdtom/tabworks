import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import manifest from "../manifest.json";

function createEvent() {
  const listeners = new Set<(...args: any[]) => any>();
  return {
    addListener(listener: (...args: any[]) => any) {
      listeners.add(listener);
    },
    removeListener(listener: (...args: any[]) => any) {
      listeners.delete(listener);
    },
    emit(...args: any[]) {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(value: string) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket closed");
    this.sent.push(value);
  }

  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const tabsOnUpdated = createEvent();
const tabsOnRemoved = createEvent();
const windowsOnRemoved = createEvent();
const debuggerOnDetach = createEvent();
const alarmsOnAlarm = createEvent();
const runtimeOnMessage = createEvent();
const runtimeOnConnect = createEvent();
const runtimeOnInstalled = createEvent();
const runtimeOnStartup = createEvent();
const navigationOnCommitted = createEvent();
const navigationOnDOMContentLoaded = createEvent();
const navigationOnCompleted = createEvent();

const localStorage = new Map<string, unknown>();
const sessionStorage = new Map<string, unknown>();
const windows = new Map<number, any>([[1, { id: 1 }]]);
const tabs = new Map<number, any>([
  [7, { id: 7, windowId: 1, url: "https://before.test", title: "Before", status: "complete", active: true }],
  [9, { id: 9, windowId: 1, url: "https://other.test", title: "Other", status: "complete", active: false }],
]);

let attachImpl = async () => {};
let detachCount = 0;
let debuggerTargetsImpl = async () => [] as any[];
let evaluateImpl = async () => ({ result: { value: 1 } });
let cookiesImpl = async () => [] as any[];
const createdAlarms: Array<{ name: string; info: any }> = [];
let windowCreateImpl = async () => ({ id: 1 });
let nextTabId = 10;

function storageArea(values: Map<string, unknown>) {
  return {
    get(keys: string | string[], callback?: (value: any) => void) {
      const names = Array.isArray(keys) ? keys : [keys];
      const result = Object.fromEntries(names.map((key) => [key, values.get(key)]));
      callback?.(result);
      return Promise.resolve(result);
    },
    set(items: Record<string, unknown>, callback?: () => void) {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
      callback?.();
      return Promise.resolve();
    },
    remove(keys: string | string[], callback?: () => void) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
      callback?.();
      return Promise.resolve();
    },
  };
}

let testing: any;

beforeAll(async () => {
  (globalThis as any).__TABWORKS_TEST_CONFIG__ = {
    debuggerTimeout: 25,
    tabTimeout: 50,
    reconnectBaseDelay: 1000,
    reconnectMaxDelay: 1000,
    heartbeatInterval: 25,
    windowIdleTimeout: 500,
    commandTimeout: 500,
  };
  (globalThis as any).WebSocket = FakeWebSocket;
  (globalThis as any).chrome = {
    action: {
      setBadgeText: () => Promise.resolve(),
      setBadgeBackgroundColor: () => Promise.resolve(),
    },
    alarms: {
      get: async () => null,
      create: async (name: string, info: any) => {
        createdAlarms.push({ name, info });
      },
      onAlarm: alarmsOnAlarm,
    },
    cookies: { getAll: (...args: any[]) => cookiesImpl(...args) },
    debugger: {
      attach: (...args: any[]) => attachImpl(...args),
      getTargets: (...args: any[]) => debuggerTargetsImpl(...args),
      detach: async () => {
        detachCount += 1;
      },
      sendCommand: async (_target: any, method: string) => {
        if (method === "Runtime.enable") return {};
        if (method === "Runtime.evaluate") return evaluateImpl();
        return {};
      },
      onDetach: debuggerOnDetach,
    },
    runtime: {
      getManifest: () => manifest,
      onMessage: runtimeOnMessage,
      onConnect: runtimeOnConnect,
      onInstalled: runtimeOnInstalled,
      onStartup: runtimeOnStartup,
    },
    scripting: { executeScript: async () => [] },
    storage: {
      local: storageArea(localStorage),
      session: storageArea(sessionStorage),
    },
    tabs: {
      get: async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error("No tab");
        return { ...tab };
      },
      query: async ({ windowId }: any) =>
        [...tabs.values()].filter((tab) => windowId === undefined || tab.windowId === windowId),
      update: async (tabId: number, changes: any) => {
        const tab = tabs.get(tabId);
        Object.assign(tab, changes);
        if (changes.url) {
          tab.status = "loading";
          tabsOnUpdated.emit(tabId, { url: changes.url, status: "loading" }, { ...tab });
        }
        return { ...tab };
      },
      create: async ({ windowId, url, active }: any) => {
        const tab = { id: nextTabId++, windowId, url, active, status: "loading" };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      remove: async (tabId: number) => {
        tabs.delete(tabId);
        tabsOnRemoved.emit(tabId);
      },
      reload: async () => {},
      sendMessage: async () => ({ ok: true }),
      onUpdated: tabsOnUpdated,
      onRemoved: tabsOnRemoved,
    },
    webNavigation: {
      getAllFrames: async () => [],
      onCommitted: navigationOnCommitted,
      onDOMContentLoaded: navigationOnDOMContentLoaded,
      onCompleted: navigationOnCompleted,
    },
    windows: {
      get: async (windowId: number) => {
        if (!windows.has(windowId)) throw new Error("No window");
        return windows.get(windowId);
      },
      create: (...args: any[]) => windowCreateImpl(...args),
      update: async (windowId: number) => windows.get(windowId),
      remove: async (windowId: number) => {
        windows.delete(windowId);
        windowsOnRemoved.emit(windowId);
      },
      onRemoved: windowsOnRemoved,
    },
  };

  ({ __testing: testing } = await import("../src/background.ts"));
  await testing.initialize();
});

afterAll(() => {
  testing.getCurrentSocket()?.close();
});

describe("MV3 manifest", () => {
  test("uses extension version 1.0.4 without global content scripts", () => {
    expect(manifest.version).toBe("1.0.4");
    expect((manifest as any).minimum_chrome_version).toBe("116");
    expect((manifest as any).content_scripts).toBeUndefined();
  });

  test("creates the fallback alarm at a 0.5 minute period", () => {
    expect(createdAlarms).toContainEqual({
      name: "keepalive",
      info: { periodInMinutes: 0.5 },
    });
  });
});

describe("command safety", () => {
  test("health returns version and timestamp", async () => {
    const result = await testing.handleCommand({ id: "health-1", action: "health" });
    expect(result).toMatchObject({
      id: "health-1",
      ok: true,
      data: { ok: true, version: "1.0.4" },
    });
    expect(result.data.timestamp).toBeNumber();
  });

  test("timeout errors include action, phase, tabId and elapsedMs", async () => {
    await expect(
      testing.withTimeout(() => new Promise(() => {}), 5, {
        action: "exec",
        phase: "sendCommand:Runtime.evaluate",
        tabId: 7,
      }),
    ).rejects.toThrow(/COMMAND_TIMEOUT action=exec phase=sendCommand:Runtime\.evaluate tabId=7 elapsedMs=\d+/);
  });

  test("serializes commands for the same tab", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = testing.withTabQueue(7, async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => (release = resolve));
      order.push("first:end");
    });
    const second = testing.withTabQueue(7, async () => order.push("second"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  test("returns DEBUGGER_BUSY without detaching another debugger", async () => {
    const beforeDetach = detachCount;
    attachImpl = async () => {
      throw new Error("Another debugger is already attached to the tab");
    };
    await expect(testing.cdpEvaluate(7, "1")).rejects.toThrow(/DEBUGGER_BUSY/);
    expect(detachCount).toBe(beforeDetach);
    attachImpl = async () => {};
  });

  test("detects an already attached DevTools target before attach", async () => {
    const beforeDetach = detachCount;
    let attachCount = 0;
    attachImpl = async () => {
      attachCount += 1;
    };
    debuggerTargetsImpl = async () => [{ tabId: 7, attached: true }];

    await expect(testing.cdpEvaluate(7, "1")).rejects.toThrow(
      /DEBUGGER_BUSY.*phase=getTargets/,
    );
    expect(attachCount).toBe(0);
    expect(detachCount).toBe(beforeDetach);

    debuggerTargetsImpl = async () => [];
    attachImpl = async () => {};
  });

  test("detaches after a stuck evaluate and the next command succeeds", async () => {
    evaluateImpl = () => new Promise(() => {});
    await expect(testing.cdpEvaluate(7, "hang()"))
      .rejects.toThrow(/COMMAND_TIMEOUT.*sendCommand:Runtime\.evaluate/);
    const afterTimeoutDetach = detachCount;
    expect(afterTimeoutDetach).toBeGreaterThan(0);

    evaluateImpl = async () => ({ result: { value: 42 } });
    await expect(testing.cdpEvaluate(7, "42")).resolves.toBe(42);
    expect(detachCount).toBe(afterTimeoutDetach + 1);
  });

  test("waitUntil=url returns on URL change without waiting for complete", async () => {
    testing.automationSessions.set("default", {
      windowId: 1,
      idleTimer: null,
      idleDeadlineAt: null,
      activeCommandCount: 0,
    });
    const startedAt = Date.now();
    const result = await testing.handleNavigate(
      {
        id: "navigate-1",
        action: "navigate",
        tabId: 7,
        url: "https://spa.test/route",
        waitUntil: "url",
        timeoutMs: 5000,
      },
      "default",
    );
    expect(result.data).toMatchObject({
      url: "https://spa.test/route",
      status: "loading",
      timedOut: false,
    });
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  test("tabs list includes status and windowId", async () => {
    const result = await testing.handleCommand({
      id: "tabs-1",
      action: "tabs",
      op: "list",
    });
    expect(result.ok).toBe(true);
    expect(result.data[0]).toMatchObject({
      tabId: 7,
      status: "loading",
      windowId: 1,
    });
  });

  test("does not arm idle close while a command is active", async () => {
    let resolveCookies!: (value: any[]) => void;
    cookiesImpl = () =>
      new Promise<any[]>((resolve) => {
        resolveCookies = resolve;
      });
    const session = testing.automationSessions.get("default");
    clearTimeout(session.idleTimer);
    let prematureIdleClose = false;
    session.idleTimer = setTimeout(() => {
      prematureIdleClose = true;
    }, 10);
    session.idleDeadlineAt = Date.now() + 10;

    const command = testing.handleCommand({
      id: "cookies-1",
      action: "cookies",
      domain: "example.com",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prematureIdleClose).toBe(false);
    expect(session.activeCommandCount).toBe(1);
    resolveCookies([]);
    await expect(command).resolves.toMatchObject({ ok: true });
    expect(session.activeCommandCount).toBe(0);
    clearTimeout(session.idleTimer);
    cookiesImpl = async () => [];
  });

  test("restores persisted sessions and validates their windows", async () => {
    const current = testing.automationSessions.get("default");
    if (current?.idleTimer) clearTimeout(current.idleTimer);
    testing.automationSessions.clear();
    sessionStorage.set("automationSessions", [
      {
        workspace: "restored",
        windowId: 1,
        idleDeadlineAt: Date.now() + 500,
      },
      {
        workspace: "missing",
        windowId: 999,
        idleDeadlineAt: Date.now() + 500,
      },
    ]);
    await testing.restoreAutomationSessions();
    expect(testing.automationSessions.has("restored")).toBe(true);
    expect(testing.automationSessions.has("missing")).toBe(false);
    clearTimeout(testing.automationSessions.get("restored")?.idleTimer);
    testing.automationSessions.clear();
  });
});

describe("concurrency isolation", () => {
  test("coalesces concurrent first-window creation per workspace", async () => {
    testing.automationSessions.clear();
    let createCount = 0;
    windowCreateImpl = async () => {
      createCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      windows.set(5, { id: 5 });
      return { id: 5 };
    };

    const [first, second] = await Promise.all([
      testing.getAutomationWindow("concurrent"),
      testing.getAutomationWindow("concurrent", { focused: true }),
    ]);
    expect(first).toBe(5);
    expect(second).toBe(5);
    expect(createCount).toBe(1);
    clearTimeout(testing.automationSessions.get("concurrent")?.idleTimer);
    testing.automationSessions.clear();
    windowCreateImpl = async () => ({ id: 1 });
  });

  test("uses the bootstrap tab for the first open without leaving a data URL", async () => {
    testing.automationSessions.clear();
    let createCount = 0;
    windowCreateImpl = async (createData: any) => {
      createCount += 1;
      const bootstrapTab = {
        id: 20,
        windowId: 6,
        url: createData.url,
        pendingUrl: createData.url,
        status: "loading",
        active: true,
      };
      windows.set(6, { id: 6 });
      tabs.set(20, bootstrapTab);
      return { id: 6, tabs: [bootstrapTab] };
    };

    const first = await testing.handleCommand({
      id: "first-open",
      action: "tabs",
      op: "new",
      workspace: "no-blank",
      url: "https://first-open.test",
    });
    expect(first).toMatchObject({ ok: true, data: { tabId: 20 } });
    expect(createCount).toBe(1);
    expect(
      [...tabs.values()].filter((tab) => tab.windowId === 6),
    ).toHaveLength(1);
    expect(
      [...tabs.values()].some(
        (tab) => tab.windowId === 6 && tab.url === "data:text/html,<html></html>",
      ),
    ).toBe(false);

    clearTimeout(testing.automationSessions.get("no-blank")?.idleTimer);
    testing.automationSessions.delete("no-blank");
    tabs.delete(20);
    windows.delete(6);
    windowCreateImpl = async () => ({ id: 1 });
  });

  test("does not create a blank fallback window for an expired explicit tabId", async () => {
    testing.automationSessions.clear();
    let createCount = 0;
    windowCreateImpl = async () => {
      createCount += 1;
      return { id: 30 };
    };

    const result = await testing.handleCommand({
      id: "expired-tab",
      action: "exec",
      workspace: "expired-tab",
      tabId: 999,
      code: "document.title",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("TAB_NOT_FOUND");
    expect(createCount).toBe(0);
    expect(testing.automationSessions.has("expired-tab")).toBe(false);
    windowCreateImpl = async () => ({ id: 1 });
  });

  test("keeps the whole navigate command ahead of exec on the same tab", async () => {
    const tab = tabs.get(7);
    Object.assign(tab, {
      windowId: 1,
      url: "https://queue.test/before",
      status: "complete",
    });
    testing.automationSessions.set("default", {
      windowId: 1,
      idleTimer: null,
      idleDeadlineAt: null,
      activeCommandCount: 0,
    });
    let attachCount = 0;
    attachImpl = async () => {
      attachCount += 1;
    };

    const navigation = testing.handleCommand({
      id: "queued-navigation",
      action: "navigate",
      tabId: 7,
      url: "https://queue.test/after",
      waitUntil: "complete",
      timeoutMs: 80,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const evaluation = testing.handleCommand({
      id: "queued-evaluation",
      action: "exec",
      tabId: 7,
      code: "42",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(attachCount).toBe(0);

    tab.status = "complete";
    tabsOnUpdated.emit(7, { status: "complete" }, { ...tab });
    await expect(navigation).resolves.toMatchObject({ ok: true });
    await expect(evaluation).resolves.toMatchObject({ ok: true, data: 42 });
    expect(attachCount).toBe(1);
    clearTimeout(testing.automationSessions.get("default")?.idleTimer);
    attachImpl = async () => {};
  });

  test("allows different tabs to run concurrently", async () => {
    const started: number[] = [];
    let release!: () => void;
    const first = testing.withTabOperationQueue(7, async () => {
      started.push(7);
      await new Promise<void>((resolve) => (release = resolve));
    });
    const second = testing.withTabOperationQueue(9, async () => {
      started.push(9);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([7, 9]);
    release();
    await Promise.all([first, second]);
  });

  test("drops a queued command after its deadline without late side effects", async () => {
    let release!: () => void;
    let lateOperationRan = false;
    const first = testing.withTabOperationQueue(7, async () => {
      await new Promise<void>((resolve) => (release = resolve));
    });
    const startedAt = Date.now();
    const second = testing.withTabOperationQueue(
      7,
      async () => {
        lateOperationRan = true;
      },
      {
        action: "exec",
        startedAt,
        deadlineAt: startedAt + 5,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await first;
    await expect(second).rejects.toThrow(/phase=tab-queue/);
    expect(lateOperationRan).toBe(false);
  });

  test("refuses close-window while another workspace command is active", async () => {
    windows.set(1, { id: 1 });
    testing.automationSessions.set("default", {
      windowId: 1,
      idleTimer: null,
      idleDeadlineAt: null,
      activeCommandCount: 0,
    });
    let resolveCookies!: (value: any[]) => void;
    const pendingCookies = new Promise<any[]>((resolve) => {
      resolveCookies = resolve;
    });
    cookiesImpl = () => pendingCookies;
    const active = testing.handleCommand({
      id: "active-command",
      action: "cookies",
      domain: "example.com",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const close = await testing.handleCommand({
      id: "concurrent-close",
      action: "close-window",
    });
    expect(close).toMatchObject({ ok: false });
    expect(close.error).toContain("WORKSPACE_BUSY");
    expect(windows.has(1)).toBe(true);
    resolveCookies([]);
    await active;
    clearTimeout(testing.automationSessions.get("default")?.idleTimer);
    cookiesImpl = async () => [];
  });
});

describe("WebSocket generation", () => {
  test("streams recording events only to the socket that started recording", () => {
    const recordingSocket = new FakeWebSocket("ws://recording-owner");
    recordingSocket.open();
    const replacementSocket = new FakeWebSocket("ws://replacement");
    replacementSocket.open();
    testing.recordingTabs.set(7, {
      sessionId: "recording-owner-test",
      tabId: 7,
      startedAt: new Date().toISOString(),
      events: [],
      eventSocket: recordingSocket,
    });

    testing.handleRecordingEvent(
      {
        type: "tabworks-recording-event",
        sessionId: "recording-owner-test",
        event: { kind: "click", x: 10, y: 20 },
      },
      { tab: { id: 7 }, frameId: 0, url: "https://recording.test" },
    );

    expect(
      recordingSocket.sent.some(
        (value) => JSON.parse(value).type === "recording-event",
      ),
    ).toBe(true);
    expect(replacementSocket.sent).toHaveLength(0);

    recordingSocket.close();
    testing.handleRecordingEvent(
      {
        type: "tabworks-recording-event",
        sessionId: "recording-owner-test",
        event: { kind: "click", x: 30, y: 40 },
      },
      { tab: { id: 7 }, frameId: 0, url: "https://recording.test" },
    );
    expect(replacementSocket.sent).toHaveLength(0);
    testing.recordingTabs.delete(7);
    replacementSocket.close();
  });

  test("sends heartbeats and never routes an old reply to the new socket", async () => {
    const oldSocket = testing.getCurrentSocket() as FakeWebSocket;
    oldSocket.open();
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(oldSocket.sent.map((value) => JSON.parse(value).type)).toContain("heartbeat");

    let resolveCookies!: (value: any[]) => void;
    const pendingCookies = new Promise<any[]>((resolve) => {
      resolveCookies = resolve;
    });
    cookiesImpl = () => pendingCookies;
    oldSocket.receive({
      id: "old-command",
      action: "cookies",
      domain: "example.com",
    });
    oldSocket.close();
    const sentAfterClose = oldSocket.sent.length;

    testing.connect();
    const newSocket = testing.getCurrentSocket() as FakeWebSocket;
    expect(newSocket).not.toBe(oldSocket);
    newSocket.open();
    resolveCookies([]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(oldSocket.sent.length).toBe(sentAfterClose);
    expect(
      newSocket.sent.some((value) => JSON.parse(value).id === "old-command"),
    ).toBe(false);
    cookiesImpl = async () => [];
    newSocket.close();
  });
});
