import { useEffect, useRef, useState } from "react";

interface Props {
	files: string[];
	value: string;
	onChange: (v: string) => void;
}

export function DatePicker({ files, value, onChange }: Props) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	// 点击外部关闭
	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node))
				setOpen(false);
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	if (files.length === 0) {
		return <span className="text-[11px] text-muted">暂无日志</span>;
	}

	return (
		<div ref={ref} className="relative">
			<button
				onClick={() => setOpen((o) => !o)}
				className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded border border-border text-[#e0e0e0] hover:border-accent hover:text-accent cursor-pointer transition-colors bg-bg select-none"
			>
				<span>{value || "选择日期"}</span>
				<svg
					width="10"
					height="10"
					viewBox="0 0 10 10"
					className="text-muted shrink-0"
					style={{
						transform: open ? "rotate(180deg)" : "none",
						transition: "transform 0.15s",
					}}
				>
					<path
						d="M1 3 L5 7 L9 3"
						stroke="currentColor"
						strokeWidth="1.5"
						fill="none"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>

			{open && (
				<div className="absolute top-full left-0 mt-1 z-50 bg-[#1a1a1a] border border-border rounded-md shadow-lg overflow-hidden min-w-[140px]">
					{files.map((f) => (
						<button
							key={f}
							onClick={() => {
								onChange(f);
								setOpen(false);
							}}
							className={`w-full text-left text-[11px] px-3 py-1.5 cursor-pointer transition-colors ${
								f === value
									? "bg-accent text-white font-semibold"
									: "text-[#e0e0e0] hover:bg-[#2a2a2a]"
							}`}
						>
							{f}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
