import type { Execution } from "../types";

interface Props {
	logs: Execution[];
	selectedIdx: number | null;
	onSelect: (i: number) => void;
}

export function LogList({ logs, selectedIdx, onSelect }: Props) {
	if (!logs.length) {
		return (
			<div className="p-6 text-center text-muted text-[12px]">暂无日志</div>
		);
	}

	return (
		<div>
			{logs.map((l, i) => {
				const t = new Date(l.startTime);
				const timeStr = t.toTimeString().slice(0, 8);
				const dur = l.durationMs ?? 0;
				const durColor =
					dur < 2000
						? "text-success"
						: dur > 8000
							? "text-orange"
							: "text-warn";
				const isErr = l.status === "error";
				const isSelected = selectedIdx === i;

				return (
					<div
						key={l.pid}
						onClick={() => onSelect(i)}
						className={`px-3 py-2.5 border-b border-border cursor-pointer transition-colors border-l-[3px]
              ${
								isErr
									? isSelected
										? "border-l-danger bg-[#2d1a1a]"
										: "border-l-danger hover:bg-[#1f1212]"
									: isSelected
										? "border-l-accent bg-[#1e2d45]"
										: "border-l-transparent hover:bg-[#222]"
							}`}
					>
						<div className="flex items-center gap-1.5 mb-1">
							<span className="text-[10px] font-semibold px-1.5 py-px rounded bg-[#1e3a5f] text-[#60a5fa]">
								{l.site}
							</span>
							<span className="text-[12px] font-medium flex-1 truncate">
								{l.routine}
							</span>
							{isErr && (
								<span className="text-[10px] font-semibold px-1.5 py-px rounded bg-[#3d1a1a] text-danger">
									ERR
								</span>
							)}
						</div>
						<div className="flex items-center gap-2 text-[11px] text-muted">
							<span className="tabular-nums">{timeStr}</span>
							<span className={`tabular-nums ${durColor}`}>{dur}ms</span>
							{l.rows !== undefined && <span>{l.rows} 行</span>}
						</div>
					</div>
				);
			})}
		</div>
	);
}
