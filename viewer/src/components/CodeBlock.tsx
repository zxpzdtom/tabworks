import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import { useEffect, useRef, useState } from "react";
import "highlight.js/styles/atom-one-dark.css";

hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("javascript", javascript);

interface Props {
	code: string;
	lang: "json" | "bash" | "javascript";
	maxHeight?: number;
}

export function CodeBlock({ code, lang, maxHeight = 320 }: Props) {
	const ref = useRef<HTMLElement>(null);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!ref.current) return;
		ref.current.removeAttribute("data-highlighted");
		ref.current.textContent = code;
		hljs.highlightElement(ref.current);
	}, [code, lang]);

	const copy = () => {
		navigator.clipboard.writeText(code).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};

	return (
		<div className="relative rounded-md overflow-hidden border border-border mt-1.5">
			<pre className="m-0">
				<code
					ref={ref}
					className={`language-${lang} !block !p-3 !text-[11.5px] !leading-relaxed !rounded-none !bg-surface2 !overflow-y-auto !whitespace-pre-wrap !break-all`}
					style={{ maxHeight, fontFamily: "var(--font-mono)" }}
				/>
			</pre>
			<div className="absolute top-1.5 right-2">
				<button
					onClick={copy}
					className={`text-[10px] px-1.5 py-0.5 rounded border cursor-pointer transition-colors
            ${
							copied
								? "bg-accent border-accent text-white"
								: "bg-surface border-border text-muted hover:text-white"
						}`}
				>
					{copied ? "已复制" : "复制"}
				</button>
			</div>
		</div>
	);
}
