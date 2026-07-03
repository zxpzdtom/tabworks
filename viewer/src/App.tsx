import { useCallback, useEffect, useRef, useState } from "react";
import { fetchFiles, fetchLogs } from "./api";
import { DatePicker } from "./components/DatePicker";
import { Detail } from "./components/Detail";
import { LogList } from "./components/LogList";
import type { Execution } from "./types";

export default function App() {
	const [files, setFiles] = useState<string[]>([]);
	const [date, setDate] = useState("");
	const [logs, setLogs] = useState<Execution[]>([]);
	const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
	const [siteFilter, setSiteFilter] = useState("");
	const [statusFilter, setStatusFilter] = useState<"" | "ok" | "error">("");
	const [live, setLive] = useState(false);
	const [autoRefresh, setAutoRefresh] = useState(
		() => localStorage.getItem("autoRefresh") !== "false",
	);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// 加载日期列表
	useEffect(() => {
		fetchFiles().then((f) => {
			const sorted = [...f].reverse();
			setFiles(sorted);
			if (sorted.length) setDate(sorted[0]);
		});
	}, []);

	// 加载指定日期的日志
	const load = useCallback(async (d: string) => {
		if (!d) return;
		setLive(false);
		try {
			const data = await fetchLogs(d);
			setLogs(data);
			setLive(true);
			setSelectedIdx((prev) => (prev !== null && data[prev] ? prev : null));
		} catch {
			setLive(false);
		}
	}, []);

	useEffect(() => {
		if (date) load(date);
	}, [date, load]);

	// 自动刷新
	useEffect(() => {
		if (autoRefresh) {
			timerRef.current = setInterval(() => load(date), 5000);
		} else {
			if (timerRef.current) clearInterval(timerRef.current);
		}
		return () => {
			if (timerRef.current) clearInterval(timerRef.current);
		};
	}, [autoRefresh, date, load]);

	// site 列表 & 筛选
	const sites = [...new Set(logs.map((l) => l.site))].sort();

	// 当前 site 下各状态的数量
	const siteLogs = siteFilter
		? logs.filter((l) => l.site === siteFilter)
		: logs;
	const okCount = siteLogs.filter((l) => l.status === "ok").length;
	const errorCount = siteLogs.filter((l) => l.status === "error").length;
	const hasMultipleStatuses = okCount > 0 && errorCount > 0;

	const filteredLogs = siteLogs.filter(
		(l) => !statusFilter || l.status === statusFilter,
	);
	const selected = selectedIdx !== null ? filteredLogs[selectedIdx] : null;

	const statusPills: Array<{
		value: "" | "ok" | "error";
		label: string;
		count?: number;
		activeClass: string;
		inactiveClass: string;
	}> = [
		{
			value: "",
			label: "全部",
			activeClass: "bg-accent border-accent text-white font-semibold",
			inactiveClass:
				"border-border text-muted hover:border-accent hover:text-accent",
		},
		{
			value: "ok",
			label: "✓ 成功",
			count: okCount,
			activeClass: "bg-success border-success text-white font-semibold",
			inactiveClass: "border-[#1a3d1a] text-success hover:border-success",
		},
		{
			value: "error",
			label: "✗ 失败",
			count: errorCount,
			activeClass: "bg-danger border-danger text-white font-semibold",
			inactiveClass: "border-[#3d1a1a] text-danger hover:border-danger",
		},
	];

	return (
		<div className="flex flex-col h-full bg-bg">
			{/* ── 顶栏 ── */}
			<header className="flex items-center gap-3 px-4 py-2 bg-surface border-b border-border shrink-0">
				<h1 className="text-[13px] font-semibold text-white shrink-0">
					Bridge 日志
				</h1>

				{/* 日期选择 */}
				<DatePicker
					files={files}
					value={date}
					onChange={(v) => {
						setDate(v);
						setSelectedIdx(null);
						setSiteFilter("");
						setStatusFilter("");
					}}
				/>

				{/* 刷新 */}
				<button
					type="button"
					onClick={() => load(date)}
					className="text-[11px] px-2.5 py-0.5 rounded border border-border text-muted hover:border-accent hover:text-accent cursor-pointer transition-colors shrink-0"
				>
					刷新
				</button>

				{/* 状态点 */}
				<span
					className={`w-1.5 h-1.5 rounded-full shrink-0 ${live ? "bg-success animate-pulse" : "bg-muted"}`}
				/>

				{/* 自动刷新 */}
				<label className="flex items-center gap-1.5 text-[11px] text-muted cursor-pointer ml-auto select-none shrink-0">
					<input
						type="checkbox"
						checked={autoRefresh}
						onChange={(e) => {
							setAutoRefresh(e.target.checked);
							localStorage.setItem("autoRefresh", String(e.target.checked));
						}}
						className="accent-accent"
					/>
					自动刷新
				</label>
			</header>

			{/* ── 主体 ── */}
			<div className="flex flex-1 overflow-hidden">
				{/* 左侧列表 */}
				<aside className="w-64 shrink-0 border-r border-border flex flex-col">
					{/* 第一行：site 筛选 */}
					{sites.length > 0 && (
						<div
							className="flex items-center gap-1 px-2 py-1.5 border-b border-border overflow-x-auto shrink-0 scrollbar-none"
							style={{ scrollbarWidth: "none" }}
						>
							<button
								type="button"
								onClick={() => {
									setSiteFilter("");
									setSelectedIdx(null);
								}}
								className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full border cursor-pointer transition-colors ${
									siteFilter === ""
										? "bg-accent border-accent text-white font-semibold"
										: "border-border text-muted hover:border-accent hover:text-accent"
								}`}
							>
								全部
							</button>
							{sites.map((s) => (
								<button
									type="button"
									key={s}
									onClick={() => {
										setSiteFilter(s);
										setSelectedIdx(null);
									}}
									className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full border cursor-pointer transition-colors whitespace-nowrap ${
										siteFilter === s
											? "bg-accent border-accent text-white font-semibold"
											: "border-border text-muted hover:border-accent hover:text-accent"
									}`}
								>
									{s}
								</button>
							))}
						</div>
					)}

					{/* 第二行：状态筛选 — 仅在同时存在成功和失败时显示 */}
					{hasMultipleStatuses && (
						<div className="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0">
							{statusPills.map((pill) => (
								<button
									type="button"
									key={pill.value}
									onClick={() => {
										setStatusFilter(pill.value);
										setSelectedIdx(null);
									}}
									className={`shrink-0 flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border cursor-pointer transition-colors whitespace-nowrap ${
										statusFilter === pill.value
											? pill.activeClass
											: pill.inactiveClass
									}`}
								>
									{pill.label}
									{pill.count !== undefined && statusFilter !== pill.value && (
										<span className="tabular-nums opacity-60">
											({pill.count})
										</span>
									)}
								</button>
							))}
						</div>
					)}

					<div className="flex-1 overflow-y-auto">
						<LogList
							logs={filteredLogs}
							selectedIdx={selectedIdx}
							onSelect={setSelectedIdx}
						/>
					</div>
				</aside>

				{/* 右侧详情 */}
				<main className="flex-1 overflow-y-auto">
					{selected ? (
						<Detail ex={selected} />
					) : (
						<div className="flex items-center justify-center h-full text-muted text-[12px]">
							← 点击左侧条目查看详情
						</div>
					)}
				</main>
			</div>
		</div>
	);
}
