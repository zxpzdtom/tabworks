import { describe, expect, test } from "bun:test";
import { inferRecordSite } from "./record";

describe("inferRecordSite", () => {
  test("uses the registrable domain label instead of the first subdomain", () => {
    expect(
      inferRecordSite("https://app.example.com/console/overview"),
    ).toBe("example");
  });

  test("handles multi-label public suffixes", () => {
    expect(inferRecordSite("https://foo.bar.com.cn/path")).toBe("bar");
  });

  test("keeps localhost and IP hosts readable", () => {
    expect(inferRecordSite("http://localhost:5173")).toBe("localhost");
    expect(inferRecordSite("http://127.0.0.1:5173")).toBe("127-0-0-1");
  });

  test("still allows simple domains", () => {
    expect(inferRecordSite("https://example.com")).toBe("example");
  });
});
