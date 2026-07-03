import { useState } from "react";
import type { Step } from "../types";
import { JsonView } from "./JsonView";

type FetchStep = Extract<Step, { kind: "fetch" }>;

interface Props {
	fetches: FetchStep[];
	startTime: string;
}

export function FetchSteps({ fetches, startTime }: Props) {
	void startTime;
	return (
		<div className="flex flex-col gap-1.5">
			{fetches.map((f) => (
				<FetchItem key={f.seq} f={f} />
			))}
		</div>
	);
}

// ─── 生成 fetch 代码 ─────────────────────────────────────────────────

function toFetchCode(f: FetchStep): string {
	// 手动拼字符串，让 body 的 JSON.stringify(...) 不被二次转义
	const lines: string[] = [`fetch(${JSON.stringify(f.url)}, {`];
	lines.push(`  method: ${JSON.stringify(f.method)},`);
	lines.push(`  credentials: 'include',`);
	if (f.headers && Object.keys(f.headers).length > 0) {
		lines.push(
			`  headers: ${JSON.stringify(f.headers, null, 2).replace(/\n/g, "\n  ")},`,
		);
	}
	if (f.body !== undefined) {
		lines.push(
			`  body: JSON.stringify(${JSON.stringify(f.body, null, 2).replace(/\n/g, "\n  ")}),`,
		);
	}
	lines.push(`})`);
	return lines.join("\n");
}

// ─── 复制按钮 ────────────────────────────────────────────────────────

function CopyButton({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			onClick={() => {
				navigator.clipboard.writeText(text);
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}}
			className={`text-[10px] px-2 py-0.5 rounded border cursor-pointer transition-colors ${
				copied
					? "border-success text-success bg-[#0d2010]"
					: "border-border text-muted hover:border-accent hover:text-accent"
			}`}
		>
			{copied ? "已复制" : label}
		</button>
	);
}

// ─── 单条请求 ────────────────────────────────────────────────────────

function FetchItem({ f }: { f: FetchStep }) {
	const [open, setOpen] = useState(false);

	const durColor =
		f.durationMs < 1000
			? "text-success"
			: f.durationMs > 5000
				? "text-orange"
				: "text-warn";

	const ridHex = f.requestId?.split("|")[0];

	const urlShort = f.url.length > 64 ? f.url.slice(0, 64) + "…" : f.url;
	const fetchCode = toFetchCode(f);

	return (
		<div className="bg-surface border border-border rounded-md overflow-hidden">
			{/* ── header 行，点击展开 ── */}
			<div
				className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-[#222] select-none"
				onClick={() => setOpen((o) => !o)}
			>
				<span className="text-[10px] text-muted w-5 shrink-0">#{f.seq}</span>
				<span className="text-[10px] font-bold text-accent w-8 shrink-0">
					{f.method}
				</span>
				<span
					className="text-[11px] flex-1 truncate text-[#e0e0e0]"
					title={f.url}
				>
					{urlShort}
				</span>

				{ridHex && (
					<span
						className="flex items-center gap-1 text-[10px] text-accent border border-[#1e3a5f] rounded px-1.5 py-0.5 font-mono shrink-0 whitespace-nowrap"
						title={f.requestId}
					>
						{ridHex}
					</span>
				)}

				<span className={`text-[11px] shrink-0 tabular-nums ${durColor}`}>
					{f.durationMs}ms
				</span>
				{f.error && <span className="text-danger text-[10px] shrink-0">✗</span>}
				<span className="text-muted text-[10px] shrink-0">
					{open ? "▾" : "▸"}
				</span>
			</div>

			{/* ── 展开内容 ── */}
			{open && (
				<div className="border-t border-border bg-[#111] flex flex-col gap-2 p-3">
					{/* URL */}
					<div className="grid grid-cols-[70px_1fr] gap-x-3 text-[11.5px]">
						<span className="text-muted pt-0.5">URL</span>
						<span className="text-[#e0e0e0] font-mono text-[11px] break-all">
							{f.url}
						</span>
					</div>

					{/* requestId */}
					{f.requestId && (
						<div className="grid grid-cols-[70px_1fr] gap-x-3 text-[11.5px]">
							<span className="text-muted pt-0.5">requestId</span>
							<span className="font-mono text-[11px] break-all">
								{f.requestId}
							</span>
						</div>
					)}

					{/* Headers */}
					{f.headers && Object.keys(f.headers).length > 0 && (
						<div>
							<div className="text-[10px] text-muted uppercase tracking-wide mb-1">
								Headers
							</div>
							<div className="flex flex-col gap-0.5 font-mono text-[11px]">
								{Object.entries(f.headers).map(([k, v]) => (
									<span key={k}>
										<span className="text-purple">{k}</span>
										<span className="text-muted">: </span>
										<span className="text-[#e0e0e0]">{v}</span>
									</span>
								))}
							</div>
						</div>
					)}

					{/* Body */}
					{f.body !== undefined && (
						<div>
							<div className="text-[10px] text-muted uppercase tracking-wide mb-1">
								Body
							</div>
							<JsonView value={f.body} />
						</div>
					)}

					{/* 错误 */}
					{f.error && (
						<div className="bg-[#1e1010] border border-[#3d1a1a] rounded p-2 text-danger text-[11px] font-mono whitespace-pre-wrap break-all">
							{f.error}
						</div>
					)}

					{/* fetch() 代码 */}
					<div>
						<div className="flex items-center justify-between mb-1">
							<span className="text-[10px] text-muted uppercase tracking-wide">
								fetch()
							</span>
							<CopyButton text={fetchCode} label="复制" />
						</div>
						<pre className="bg-[#0d0d0d] rounded p-2.5 text-[11px] font-mono text-[#e0e0e0] whitespace-pre overflow-x-auto border border-border">
							{fetchCode}
						</pre>
					</div>
				</div>
			)}
		</div>
	);
}
