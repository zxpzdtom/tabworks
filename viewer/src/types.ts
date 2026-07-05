export type Step =
	| { kind: "check"; seq: number; time: string; durationMs: number }
	| { kind: "nav"; seq: number; time: string; url: string; durationMs: number }
	| {
			kind: "run";
			seq: number;
			time: string;
			description: string;
			durationMs: number;
	  }
	| {
			kind: "fetch";
			seq: number;
			time: string;
			url: string;
			method: string;
			requestId?: string;
			headers?: Record<string, string>;
			body?: unknown;
			durationMs: number;
			error?: string;
	  }
	| { kind: "js"; seq: number; time: string; code: string }
	| { kind: "tab"; seq: number; time: string; url: string }
	| {
			kind: "tap";
			seq: number;
			time: string;
			selector: string;
			mode: string;
			tag?: string;
			text?: string;
			durationMs: number;
	  }
	| {
			kind: "input";
			seq: number;
			time: string;
			selector: string;
			text: string;
			durationMs: number;
	  }
	| {
			kind: "scroll";
			seq: number;
			time: string;
			direction: string;
			distance: number;
	  }
	| { kind: "sleep"; seq: number; time: string; durationMs: number }
	| {
			kind: "screenshot";
			seq: number;
			time: string;
			format: string;
			fullPage: boolean;
			filePath: string;
			bytes: number;
			durationMs: number;
	  }
	| {
			kind: "error";
			seq: number;
			time: string;
			message: string;
			stack?: string;
	  };

export interface Execution {
	pid: number;
	site: string;
	routine: string;
	startTime: string;
	argv: string[];
	status: "running" | "ok" | "error";
	durationMs: number;
	rows?: number;
	result?: unknown;
	error?: string;
	steps: Step[];
}
