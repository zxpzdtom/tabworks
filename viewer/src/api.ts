import type { Execution } from "./types";

export async function fetchFiles(): Promise<string[]> {
	const res = await fetch("/api/files");
	const data = (await res.json()) as { files: string[] };
	return data.files ?? [];
}

export async function fetchLogs(date: string): Promise<Execution[]> {
	const res = await fetch(`/api/logs?date=${date}`);
	const data = (await res.json()) as { logs: Execution[] };
	return data.logs ?? [];
}
