import { useState } from "react";
import type { Step } from "../types";
import { CodeBlock } from "./CodeBlock";
import { JsonView } from "./JsonView";

interface Props {
	steps: Step[];
	startTime: string;
}

export function Timeline({ steps, startTime }: Props) {
	if (!steps.length) return null;
	void startTime;
	return (
		<div className="flex flex-col gap-1.5">
			{steps.map((s) => {
				if (s.kind === "check") return <CheckItem key={s.seq} s={s} />;
				if (s.kind === "nav") return <NavItem key={s.seq} s={s} />;
				if (s.kind === "run") return <RunItem key={s.seq} s={s} />;
				if (s.kind === "fetch") return <FetchItem key={s.seq} s={s} />;
				if (s.kind === "js") return <JsItem key={s.seq} s={s} />;
				if (s.kind === "tab") return <TabItem key={s.seq} s={s} />;
				if (s.kind === "tap") return <TapItem key={s.seq} s={s} />;
				if (s.kind === "input") return <InputItem key={s.seq} s={s} />;
				if (s.kind === "scroll") return <ScrollItem key={s.seq} s={s} />;
				if (s.kind === "sleep") return <SleepItem key={s.seq} s={s} />;
				if (s.kind === "screenshot")
					return <ScreenshotItem key={s.seq} s={s} />;
				if (s.kind === "error") return <ErrorItem key={s.seq} s={s} />;
				return null;
			})}
		</div>
	);
}

// ─── fetch 步骤 ──────────────────────────────────────────────────────

function toFetchCode(s: Extract<Step, { kind: "fetch" }>): string {
	const lines: string[] = [`fetch(${JSON.stringify(s.url)}, {`];
	lines.push(`  method: ${JSON.stringify(s.method)},`);
	lines.push(`  credentials: 'include',`);
	if (s.headers && Object.keys(s.headers).length > 0) {
		lines.push(
			`  headers: ${JSON.stringify(s.headers, null, 2).replace(/\n/g, "\n  ")},`,
		);
	}
	if (s.body !== undefined) {
		lines.push(
			`  body: JSON.stringify(${JSON.stringify(s.body, null, 2).replace(/\n/g, "\n  ")}),`,
		);
	}
	lines.push(`})`);
	return lines.join("\n");
}

// 可展开行的 chevron 指示器，放在标签左侧
function Chevron({ open }: { open: boolean }) {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 12 12"
			fill="none"
			aria-hidden="true"
			className="shrink-0 text-accent transition-transform duration-150"
			style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
		>
			<title>{open ? "收起" : "展开"}</title>
			<path
				d="M4 2.5 L8 6 L4 9.5"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
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
			{copied ? "已复制" : "复制"}
		</button>
	);
}

function FetchItem({
	s,
}: {
	s: Extract<Step, { kind: "fetch" }>;
}) {
	const [open, setOpen] = useState(false);

	const durColor =
		s.durationMs < 1000
			? "text-success"
			: s.durationMs > 5000
				? "text-orange"
				: "text-warn";

	const ridHex = s.requestId?.split("|")[0];

	const urlShort = s.url.length > 64 ? `${s.url.slice(0, 64)}…` : s.url;
	const fetchCode = toFetchCode(s);

	return (
		<div className="bg-surface border border-border rounded-md overflow-hidden">
			<button
				type="button"
				className="w-full flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-[#222] select-none text-left"
				onClick={() => setOpen((o) => !o)}
			>
				<Chevron open={open} />
				<span className="text-[9px] font-bold text-muted w-7 shrink-0 uppercase">
					HTTP
				</span>
				<span className="text-[10px] font-bold text-accent w-8 shrink-0">
					{s.method}
				</span>
				<span
					className="text-[11px] flex-1 truncate text-[#e0e0e0]"
					title={s.url}
				>
					{urlShort}
				</span>

				{ridHex && (
					<span
						className="flex items-center gap-1 text-[10px] text-accent border border-[#1e3a5f] rounded px-1.5 py-0.5 font-mono shrink-0 whitespace-nowrap"
						title={s.requestId}
					>
						{ridHex}
					</span>
				)}

				<span className={`text-[11px] shrink-0 tabular-nums ${durColor}`}>
					{s.durationMs}ms
				</span>
				{s.error && (
					<span className="text-danger text-[11px] font-bold shrink-0">✗</span>
				)}
			</button>

			{open && (
				<div className="border-t border-border bg-[#111] flex flex-col gap-2 p-3">
					<div className="grid grid-cols-[70px_1fr] gap-x-3 text-[11.5px]">
						<span className="text-muted pt-0.5">URL</span>
						<span className="text-[#e0e0e0] font-mono text-[11px] break-all">
							{s.url}
						</span>
					</div>

					{s.requestId && (
						<div className="grid grid-cols-[70px_1fr] gap-x-3 text-[11.5px]">
							<span className="text-muted pt-0.5">requestId</span>
							<span className="font-mono text-[11px] break-all">
								{s.requestId}
							</span>
						</div>
					)}

					{s.headers && Object.keys(s.headers).length > 0 && (
						<div>
							<div className="text-[10px] text-muted uppercase tracking-wide mb-1">
								Headers
							</div>
							<div className="flex flex-col gap-0.5 font-mono text-[11px]">
								{Object.entries(s.headers).map(([k, v]) => (
									<span key={k}>
										<span className="text-purple">{k}</span>
										<span className="text-muted">: </span>
										<span className="text-[#e0e0e0]">{v}</span>
									</span>
								))}
							</div>
						</div>
					)}

					{s.body !== undefined && (
						<div>
							<div className="text-[10px] text-muted uppercase tracking-wide mb-1">
								Body
							</div>
							<JsonView value={s.body} />
						</div>
					)}

					{s.error && (
						<div className="bg-[#1e1010] border border-[#3d1a1a] rounded p-2 text-danger text-[11px] font-mono whitespace-pre-wrap break-all">
							{s.error}
						</div>
					)}

					<div>
						<div className="flex items-center justify-between mb-1">
							<span className="text-[10px] text-muted uppercase tracking-wide">
								fetch()
							</span>
							<CopyButton text={fetchCode} />
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

// ─── run-js 步骤 ─────────────────────────────────────────────────────

function JsItem({ s }: { s: Extract<Step, { kind: "js" }> }) {
	const [open, setOpen] = useState(false);
	const short =
		s.code.length > 60 ? `${s.code.slice(0, 60).replace(/\n/g, " ")}…` : s.code;

	return (
		<div className="bg-surface border border-border rounded-md overflow-hidden">
			<button
				type="button"
				className="w-full flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-[#222] select-none text-left"
				onClick={() => setOpen((o) => !o)}
			>
				<Chevron open={open} />
				<span className="text-[9px] font-bold text-purple w-7 shrink-0 uppercase">
					JS
				</span>
				<span
					className="text-[11px] flex-1 truncate font-mono text-purple"
					title={s.code}
				>
					{short}
				</span>
			</button>

			{open && (
				<div className="border-t border-border bg-[#111] p-3">
					<CodeBlock code={s.code} lang="javascript" maxHeight={480} />
				</div>
			)}
		</div>
	);
}

// ─── Bridge 检查步骤 ─────────────────────────────────────────────────

function CheckItem({ s }: { s: Extract<Step, { kind: "check" }> }) {
	return (
		<div className="bg-surface border border-border rounded-md px-2.5 py-1.5 flex items-center gap-2">
			<span className="text-[9px] font-bold text-muted w-7 shrink-0 uppercase">
				CHK
			</span>
			<span className="text-[11px] flex-1 text-[#e0e0e0]">
				Bridge 连通性检查
			</span>
			{s.durationMs > 0 && (
				<span className="text-[11px] shrink-0 tabular-nums text-muted">
					{s.durationMs}ms
				</span>
			)}
		</div>
	);
}

// ─── 导航步骤 ────────────────────────────────────────────────────────

function NavItem({ s }: { s: Extract<Step, { kind: "nav" }> }) {
	const urlShort = s.url.length > 64 ? `${s.url.slice(0, 64)}…` : s.url;
	return (
		<div className="bg-surface border border-border rounded-md px-2.5 py-1.5 flex items-center gap-2">
			<span className="text-[9px] font-bold text-success w-7 shrink-0 uppercase">
				NAV
			</span>
			<a
				href={s.url}
				target="_blank"
				rel="noreferrer"
				className="text-[11px] flex-1 truncate text-accent font-mono hover:underline"
				title={s.url}
				onClick={(e) => e.stopPropagation()}
			>
				{urlShort}
			</a>
			{s.durationMs > 0 && (
				<span className="text-[11px] shrink-0 tabular-nums text-muted">
					{s.durationMs}ms
				</span>
			)}
		</div>
	);
}

// ─── 业务逻辑执行步骤 ─────────────────────────────────────────────────

function RunItem({ s }: { s: Extract<Step, { kind: "run" }> }) {
	return (
		<div className="bg-surface border border-border rounded-md px-2.5 py-1.5 flex items-center gap-2">
			<span className="text-[9px] font-bold text-purple w-7 shrink-0 uppercase">
				RUN
			</span>
			<span className="text-[11px] flex-1 text-[#e0e0e0]">
				{s.description || "执行业务逻辑"}
			</span>
			{s.durationMs > 0 && (
				<span className="text-[11px] shrink-0 tabular-nums text-muted">
					{s.durationMs}ms
				</span>
			)}
		</div>
	);
}

// ─── 关闭标签页步骤 ───────────────────────────────────────────────────

function TabItem({ s }: { s: Extract<Step, { kind: "tab" }> }) {
	const urlShort = s.url.length > 64 ? `${s.url.slice(0, 64)}…` : s.url;
	return (
		<div className="bg-surface border border-border rounded-md px-2.5 py-1.5 flex items-center gap-2">
			<span className="text-[9px] font-bold text-muted w-7 shrink-0 uppercase">
				TAB
			</span>
			<span className="text-[11px] text-muted shrink-0">关闭</span>
			<span
				className="text-[11px] flex-1 truncate text-muted font-mono"
				title={s.url}
			>
				{urlShort}
			</span>
		</div>
	);
}

// ─── 报错步骤 ────────────────────────────────────────────────────────

function ErrorItem({ s }: { s: Extract<Step, { kind: "error" }> }) {
	const [open, setOpen] = useState(false);

	return (
		<div className="bg-[#1e1010] border border-[#3d1a1a] rounded-md overflow-hidden">
			<button
				type="button"
				className="w-full flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-[#251515] select-none text-left"
				onClick={() => setOpen((o) => !o)}
			>
				{s.stack && <Chevron open={open} />}
				<span className="text-[9px] font-bold text-danger w-7 shrink-0 uppercase">
					ERR
				</span>
				<span
					className="text-[11px] flex-1 truncate text-danger font-mono"
					title={s.message}
				>
					{s.message}
				</span>
			</button>

			{open && s.stack && (
				<div className="border-t border-[#3d1a1a] px-2.5 py-2">
					<pre className="text-[10.5px] text-danger font-mono whitespace-pre-wrap break-all leading-relaxed">
						{s.stack}
					</pre>
				</div>
			)}
		</div>
	);
}

// ─── tap 点击步骤 ─────────────────────────────────────────────────────

function TapItem({ s }: { s: Extract<Step, { kind: "tap" }> }) {
	const selShort =
		s.selector.length > 50 ? `${s.selector.slice(0, 50)}…` : s.selector;
	return (
		<div className="bg-surface border border-border rounded-md px-2.5 py-1.5 flex items-center gap-2">
			<span className="text-[9px] font-bold text-accent w-7 shrink-0 uppercase">
				TAP
			</span>
			<span
				className="text-[11px] font-mono text-accent flex-1 truncate"
				title={s.selector}
			>
				{selShort}
			</span>
			{s.tag && (
				<span className="text-[10px] text-muted shrink-0 font-mono">
					&lt;{s.tag.toLowerCase()}&gt;
					{s.text ? ` "${s.text.slice(0, 20)}"` : ""}
				</span>
			)}
			{s.mode !== "dom" && (
				<span className="text-[9px] text-muted shrink-0 border border-border rounded px-1">
					{s.mode}
				</span>
			)}
			{s.durationMs > 0 && (
				<span className="text-[11px] shrink-0 tabular-nums text-muted">
					{s.durationMs}ms
				</span>
			)}
		</div>
	);
}

// ─── input 输入步骤 ───────────────────────────────────────────────────

function InputItem({ s }: { s: Extract<Step, { kind: "input" }> }) {
	const selShort =
		s.selector.length > 40 ? `${s.selector.slice(0, 40)}…` : s.selector;
	const textShort = s.text.length > 30 ? `${s.text.slice(0, 30)}…` : s.text;
	return (
		<div className="bg-surface border border-border rounded-md px-2.5 py-1.5 flex items-center gap-2">
			<span className="text-[9px] font-bold text-warn w-7 shrink-0 uppercase">
				INP
			</span>
			<span
				className="text-[11px] font-mono text-muted truncate shrink-0"
				title={s.selector}
				style={{ maxWidth: 160 }}
			>
				{selShort}
			</span>
			<span className="text-muted text-[10px] shrink-0">←</span>
			<span
				className="text-[11px] text-[#e0e0e0] flex-1 truncate"
				title={s.text}
			>
				"{textShort}"
			</span>
			{s.durationMs > 0 && (
				<span className="text-[11px] shrink-0 tabular-nums text-muted">
					{s.durationMs}ms
				</span>
			)}
		</div>
	);
}

// ─── scroll 滚动步骤 ──────────────────────────────────────────────────

const SCROLL_ICON: Record<string, string> = {
	up: "↑",
	down: "↓",
	top: "⇈",
	bottom: "⇊",
};

function ScrollItem({ s }: { s: Extract<Step, { kind: "scroll" }> }) {
	return (
		<div className="bg-surface border border-border rounded-md px-2.5 py-1.5 flex items-center gap-2">
			<span className="text-[9px] font-bold text-muted w-7 shrink-0 uppercase">
				SCR
			</span>
			<span className="text-[13px] shrink-0 text-muted">
				{SCROLL_ICON[s.direction] ?? "↕"}
			</span>
			<span className="text-[11px] text-[#e0e0e0] flex-1">
				{s.direction}
				{s.distance > 0 && (
					<span className="text-muted ml-1">{s.distance}px</span>
				)}
			</span>
		</div>
	);
}

// ─── sleep 等待步骤 ──────────────────────────────────────────────────

function SleepItem({ s }: { s: Extract<Step, { kind: "sleep" }> }) {
	return (
		<div className="bg-surface border border-border rounded-md px-2.5 py-1.5 flex items-center gap-2">
			<span className="text-[9px] font-bold text-muted w-7 shrink-0 uppercase">
				SLP
			</span>
			<span className="text-[11px] text-[#e0e0e0] flex-1">
				等待页面异步更新
			</span>
			<span className="text-[11px] shrink-0 tabular-nums text-muted">
				{s.durationMs}ms
			</span>
		</div>
	);
}

// ─── screenshot 截图步骤 ──────────────────────────────────────────────

function ScreenshotItem({ s }: { s: Extract<Step, { kind: "screenshot" }> }) {
	const [open, setOpen] = useState(false);
	const imgSrc = s.filePath
		? `/api/screenshot?path=${encodeURIComponent(s.filePath)}`
		: null;
	const sizeKb = s.bytes ? `${(s.bytes / 1024).toFixed(1)} KB` : null;

	return (
		<div className="bg-surface border border-border rounded-md overflow-hidden">
			<button
				type="button"
				className="w-full flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-[#222] select-none text-left"
				onClick={() => setOpen((o) => !o)}
			>
				<Chevron open={open} />
				<span className="text-[9px] font-bold text-purple w-7 shrink-0 uppercase">
					IMG
				</span>
				<span className="text-[11px] text-[#e0e0e0] flex-1">
					截图{s.fullPage ? "（整页）" : ""}
					<span className="text-muted ml-1 text-[10px]">
						{s.format.toUpperCase()}
					</span>
				</span>
				{sizeKb && (
					<span className="text-[11px] shrink-0 tabular-nums text-muted">
						{sizeKb}
					</span>
				)}
				{s.durationMs > 0 && (
					<span className="text-[11px] shrink-0 tabular-nums text-success">
						{s.durationMs}ms
					</span>
				)}
			</button>

			{open && (
				<div className="border-t border-border bg-[#111] p-3 flex flex-col gap-2">
					{imgSrc ? (
						<>
							<img
								src={imgSrc}
								alt="screenshot"
								className="w-full rounded border border-border"
								style={{
									maxHeight: 480,
									objectFit: "contain",
									background: "#000",
								}}
							/>
							<div className="flex items-center gap-2">
								<a
									href={imgSrc}
									target="_blank"
									rel="noreferrer"
									className="text-[10px] px-2 py-0.5 rounded border border-border text-muted hover:border-accent hover:text-accent transition-colors"
								>
									在新标签页打开
								</a>
								{s.filePath && (
									<span
										className="text-[10px] text-muted font-mono truncate flex-1"
										title={s.filePath}
									>
										{s.filePath}
									</span>
								)}
							</div>
						</>
					) : (
						<div className="text-[11px] text-muted">截图文件不可用</div>
					)}
				</div>
			)}
		</div>
	);
}
