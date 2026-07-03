import { useState } from "react";
import type { Execution } from "../types";
import { CodeBlock } from "./CodeBlock";
import { JsonView } from "./JsonView";
import { ResultTable } from "./ResultTable";
import { Timeline } from "./Timeline";

interface Props {
	ex: Execution;
}

export function Detail({ ex }: Props) {
	const [resultView, setResultView] = useState<"table" | "json">("table");

	const t = new Date(ex.startTime);
	const statusColor =
		ex.status === "ok"
			? "text-success"
			: ex.status === "error"
				? "text-danger"
				: "text-warn";
	const statusLabel = { ok: "成功", error: "失败", running: "执行中" }[
		ex.status
	];

	const cmd = `tw ${ex.site} ${ex.routine} ${ex.argv.join(" ")}`;

	const isTableResult =
		Array.isArray(ex.result) &&
		ex.result.length > 0 &&
		typeof ex.result[0] === "object" &&
		ex.result[0] !== null;

	return (
		<div className="flex flex-col gap-3 p-4 text-[12px]">
			{/* ── 概览 ── */}
			<div className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1">
				<span className="text-muted">时间</span>
				<span>{t.toLocaleString("zh-CN")}</span>
				<span className="text-muted">状态</span>
				<span className={`font-semibold ${statusColor}`}>{statusLabel}</span>
				<span className="text-muted">耗时</span>
				<span className="tabular-nums">{ex.durationMs}ms</span>
				{ex.rows !== undefined && (
					<>
						<span className="text-muted">结果行数</span>
						<span>{ex.rows} 行</span>
					</>
				)}
			</div>

			{/* ── 命令 ── */}
			<Section title="命令">
				<CodeBlock code={cmd} lang="bash" maxHeight={80} />
			</Section>

			{/* ── 错误 ── */}
			{ex.error && (
				<Section title="错误" titleClass="text-danger">
					<div className="mt-1.5 bg-[#1e1010] border border-[#3d1a1a] rounded-md p-3 text-danger font-mono text-[11px] whitespace-pre-wrap break-all leading-relaxed">
						{ex.error}
					</div>
				</Section>
			)}

			{/* ── 执行链路 ── */}
			{(ex.steps?.length ?? 0) > 0 && (
				<Section title={`链路 (${ex.steps.length})`}>
					<Timeline steps={ex.steps} startTime={ex.startTime} />
				</Section>
			)}

			{/* ── 结果 ── */}
			{ex.result !== undefined && (
				<Section
					title="结果"
					extra={
						isTableResult && (
							<div className="flex border-b border-border -mb-px ml-2">
								{(["table", "json"] as const).map((v) => (
									<button
										key={v}
										onClick={() => setResultView(v)}
										className={`text-[11px] px-3 py-1 border-b-2 cursor-pointer transition-colors
                      ${
												resultView === v
													? "border-accent text-accent font-semibold"
													: "border-transparent text-muted hover:text-[#e0e0e0]"
											}`}
									>
										{v === "table" ? "表格" : "JSON"}
									</button>
								))}
							</div>
						)
					}
				>
					{isTableResult && resultView === "table" ? (
						<ResultTable data={ex.result} />
					) : (
						<JsonView value={ex.result} maxHeight={420} />
					)}
				</Section>
			)}
		</div>
	);
}

function Section({
	title,
	titleClass = "text-muted",
	extra,
	children,
}: {
	title: string;
	titleClass?: string;
	extra?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div>
			<hr className="border-border mb-3" />
			<div className="flex items-center gap-2 mb-1.5">
				<span
					className={`text-[11px] font-semibold uppercase tracking-wide ${titleClass}`}
				>
					{title}
				</span>
				{extra}
			</div>
			{children}
		</div>
	);
}
