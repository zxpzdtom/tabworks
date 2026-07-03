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
  if (fmt === "json" || !columns?.length) {
    return JSON.stringify(rows, null, 2);
  }
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

  if (fmt === "json" || !columns?.length) {
    return JSON.stringify(
      { pagination: { page, pageSize, total, totalPages }, data: rows },
      null,
      2,
    );
  }

  const table = renderTable(rows, columns);
  const info = `第 ${page} 页 / 共 ${total} 条（每页 ${pageSize} 条，共 ${totalPages} 页）`;
  return `${table}\n${info}`;
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
