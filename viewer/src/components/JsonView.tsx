/**
 * JsonView — 基于 highlight.js 的 JSON 语法高亮组件
 *
 * 使用 hljs atom-one-dark 配色，背景透明融入页面。
 */

import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import { useMemo } from "react";
import "highlight.js/styles/atom-one-dark.css";

hljs.registerLanguage("json", json);

interface Props {
	value: unknown;
	maxHeight?: number;
}

export function JsonView({ value, maxHeight }: Props) {
	const html = useMemo(() => {
		const text = JSON.stringify(value, null, 2);
		return hljs.highlight(text, { language: "json" }).value;
	}, [value]);

	return (
		<div
			className="rounded-md border border-border overflow-auto font-mono"
			style={{
				background: "#282c34",
				...(maxHeight ? { maxHeight } : {}),
			}}
		>
			<pre
				className="p-2.5 text-[11.5px] leading-relaxed m-0 whitespace-pre"
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		</div>
	);
}
