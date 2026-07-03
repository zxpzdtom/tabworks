import { useState } from "react";

interface Props {
	data: unknown;
}

// 递归渲染一张表格（支持嵌套数组就地展开子表格）
export function ResultTable({ data }: Props) {
	const rows = Array.isArray(data) ? data : [data];

	if (rows.length === 0 || typeof rows[0] !== "object" || rows[0] === null) {
		// 非对象数组，降级为 JSON 文本
		return (
			<pre className="text-[11.5px] text-[#cdd6f4] font-mono whitespace-pre-wrap break-all p-3 bg-surface2 rounded-md border border-border">
				{JSON.stringify(data, null, 2)}
			</pre>
		);
	}

	// 收集所有列（保持插入顺序）
	const keys = [
		...new Set(
			rows.flatMap((r) =>
				r && typeof r === "object" ? Object.keys(r as object) : [],
			),
		),
	];

	return (
		<div className="overflow-auto max-h-[420px] border border-border rounded-md mt-1.5">
			<table
				className="w-full border-collapse text-[11.5px]"
				style={{ fontFamily: "var(--font-mono)" }}
			>
				<thead>
					<tr>
						{keys.map((k) => (
							<th
								key={k}
								className="sticky top-0 z-10 bg-[#1a1a2e] text-muted font-semibold text-left px-3 py-1.5 border-b border-border whitespace-nowrap"
							>
								{k}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, i) => (
						<TableRow
							key={i}
							row={row as Record<string, unknown>}
							keys={keys}
						/>
					))}
				</tbody>
			</table>
		</div>
	);
}

// 单行，支持嵌套数组展开
function TableRow({
	row,
	keys,
}: {
	row: Record<string, unknown>;
	keys: string[];
}) {
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});

	const toggle = (k: string) =>
		setExpanded((prev) => ({ ...prev, [k]: !prev[k] }));

	return (
		<>
			<tr className="hover:bg-[#1a1a2a] group">
				{keys.map((k) => {
					const v = row?.[k];
					const isExpandable =
						Array.isArray(v) &&
						v.length > 0 &&
						typeof v[0] === "object" &&
						v[0] !== null;

					return (
						<td
							key={k}
							className="px-3 py-1.5 border-b border-[#1f1f1f] align-top group-last:border-0"
						>
							{isExpandable ? (
								<button
									onClick={() => toggle(k)}
									className="text-purple cursor-pointer hover:underline whitespace-nowrap"
								>
									{expanded[k] ? "▾" : "▸"} [{v.length} 项]
								</button>
							) : (
								<CellValue v={v} />
							)}
						</td>
					);
				})}
			</tr>

			{/* 展开的嵌套子表格：独占一行，横跨所有列 */}
			{keys.map((k) => {
				const v = row?.[k];
				if (!expanded[k] || !Array.isArray(v)) return null;
				return (
					<tr key={`${k}-expanded`} className="bg-[#111]">
						<td
							colSpan={keys.length}
							className="px-4 py-2 border-b border-[#1f1f1f]"
						>
							<div className="text-[10px] text-muted mb-1 uppercase tracking-wide">
								{k}
							</div>
							<ResultTable data={v} />
						</td>
					</tr>
				);
			})}
		</>
	);
}

function CellValue({ v }: { v: unknown }) {
	if (v === null || v === undefined)
		return <span className="text-muted italic">—</span>;
	if (typeof v === "boolean")
		return (
			<span className={v ? "text-success" : "text-danger"}>{String(v)}</span>
		);
	if (typeof v === "number")
		return <span className="text-warn tabular-nums">{String(v)}</span>;
	if (Array.isArray(v)) {
		if (v.length === 0) return <span className="text-muted italic">[]</span>;
		// 简单值数组直接展示
		if (v.every((i) => typeof i !== "object" || i === null))
			return <span className="text-purple">{v.join(", ")}</span>;
		// 对象数组但不可展开（已在 TableRow 处理），理论上不会走到这里
		return <span className="text-orange">[{v.length} 项]</span>;
	}
	if (typeof v === "object")
		return <span className="text-orange">{"{…}"}</span>;

	const s = String(v);
	return (
		<span className="text-[#e0e0e0]">
			{s.length > 120 ? s.slice(0, 120) + "…" : s}
		</span>
	);
}
