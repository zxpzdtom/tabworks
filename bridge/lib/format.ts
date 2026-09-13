/**
 * lib/format.ts — 输出格式化
 *
 * table 格式使用 cli-table3，json 格式直接 JSON.stringify。
 */

import Table from "cli-table3";
import type { Format, Row } from "./types";

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
}

/**
 * 基础格式化：无分页信息。
 */
export function format(rows: Row[], fmt: Format, columns?: string[]): string {
  if (fmt === "json") {
    return JSON.stringify(rows, null, 2);
  }
  const resolved = fmt === "auto" ? selectAutoFormat(rows, columns) : fmt;
  if (resolved === "list" || !columns?.length) return renderList(rows, columns);
  return renderTable(rows, columns);
}

/**
 * 带分页信息的格式化。
 * - table 模式：表格下方追加 "第 X 页，共 Y 条（每页 Z 条）"
 * - json 模式：包成 { pagination: {...}, data: [...] }
 */
export function formatWithPagination(
  rows: Row[],
  fmt: Format,
  columns: string[] | undefined,
  pagination: Pagination,
): string {
  const { page, pageSize, total } = pagination;
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;

  if (fmt === "json") {
    return JSON.stringify(
      { pagination: { page, pageSize, total, totalPages }, data: rows },
      null,
      2,
    );
  }

  const table = format(rows, fmt, columns);
  const info = `第 ${page} 页 / 共 ${total} 条（每页 ${pageSize} 条，共 ${totalPages} 页）`;
  return `${table}\n${info}`;
}

export function selectAutoFormat(
  rows: Row[],
  columns?: string[],
  terminalWidth = process.stdout.columns || 120,
): "table" | "list" {
  if (!columns?.length || terminalWidth < 88) return "list";
  const values = rows.flatMap((row) => columns.map((column) => String(row[column] ?? "")));
  const longest = values.reduce((max, value) => Math.max(max, value.length), 0);
  const estimated = columns.reduce((sum, column) => {
    const width = Math.max(column.length, ...rows.map((row) => String(row[column] ?? "").length));
    return sum + Math.min(width, 36) + 3;
  }, 1);
  return longest > Math.max(80, terminalWidth * 0.7) || estimated > terminalWidth ? "list" : "table";
}

function mustKeepComplete(column: string, value: string): boolean {
  return /url/i.test(column) || /^https?:\/\//i.test(value);
}

function displayValue(column: string, value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value ?? "");
  if (mustKeepComplete(column, text) || text.length <= 240) return text;
  return `${text.slice(0, 239)}…`;
}

function renderList(rows: Row[], columns?: string[]): string {
  if (rows.length === 0) return "（无数据）";
  return rows.map((row, index) => {
    const keys = columns?.length ? columns : Object.keys(row);
    return [`#${index + 1}`, ...keys.map((key) => `${key}: ${displayValue(key, row[key])}`)].join("\n");
  }).join("\n\n");
}

function renderTable(rows: Row[], columns: string[]): string {
  if (rows.length === 0) return "（无数据）";

  const table = new Table({
    head: columns,
    style: {
      head: [], // 不加颜色，AI 读取更干净
      border: [],
    },
    wordWrap: true,
  });

  for (const row of rows) {
    table.push(columns.map((col) => String(row[col] ?? "")));
  }

  return table.toString();
}
