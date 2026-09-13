import { expect, test } from "bun:test";
// @ts-ignore JavaScript helper is shared verbatim with the Node bridge process.
import { isApplicationSocketHealthy, rejectPendingForSocket, takePendingForSocket } from "../scripts/socket-state.mjs";

test("旧 WebSocket 关闭只拒绝属于旧连接的 pending", () => {
  const oldSocket = {};
  const newSocket = {};
  const rejected: string[] = [];
  const pending = new Map([
    ["old", { socket: oldSocket, timer: setTimeout(() => {}, 10_000), reject: () => rejected.push("old") }],
    ["new", { socket: newSocket, timer: setTimeout(() => {}, 10_000), reject: () => rejected.push("new") }],
  ]);
  expect(rejectPendingForSocket(pending, oldSocket, new Error("closed"))).toBe(1);
  expect(rejected).toEqual(["old"]);
  expect(pending.has("new")).toBe(true);
  const item = takePendingForSocket(pending, "new", oldSocket);
  expect(item).toBeNull();
  expect(takePendingForSocket(pending, "new", newSocket)).not.toBeNull();
});

test("应用层超过 45 秒无 JS 回包才判为僵死", () => {
  expect(isApplicationSocketHealthy(true, 10_000, 54_999, 45_000)).toBe(true);
  expect(isApplicationSocketHealthy(true, 10_000, 55_001, 45_000)).toBe(false);
  expect(isApplicationSocketHealthy(true, null, 20_000, 45_000)).toBe(false);
  expect(isApplicationSocketHealthy(false, 19_000, 20_000, 45_000)).toBe(false);
});
