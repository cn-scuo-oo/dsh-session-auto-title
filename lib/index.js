/**
 * dsh-session-auto-title — a model-backed `ctx.sessionTitle` provider that
 * re-titles a session after **every** conversation turn, in one fixed
 * convention: `MMDD｜类型｜主题`.
 *
 * Why a provider and not an external script: a session's log has exactly one
 * writer at a time (a cross-process kernel lock), and the process that runs the
 * conversation holds it. An external renamer therefore cannot open a live
 * session for writing at all — the only place that can rename a running session
 * is the process itself, and `ctx.sessionTitle` is that in-process path.
 *
 * Cadence: the plugin re-titles on every `turn/end` through the service's
 * explicit `refresh()` path, because the service's own automatic cadence only
 * starts a generation when that turn's request route is logged — and a
 * long-lived session logs one `request/header` per series, not one per turn.
 * A manually renamed session is pinned (`source.kind === "user"`) and is left
 * alone; `unpinSessions` releases one such pin deliberately.
 *
 * @module dsh-session-auto-title
 */
import z from "@deepseek-ai/schemastery";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { normalizeSessionTitle } from "@deepseek-ai/dsh-session-title";
import { deepFreeze } from "@deepseek-ai/dsh-util-values";

/** Stable title-provider identity recorded on every generated title. */
const name = "session-auto-title-convention";

const inject = ["sessionTitle", "llm", "sessions"];

/** The eight accepted categories of the user's naming convention. */
const CATEGORIES = ["功能", "设计", "修复", "优化", "发布", "探索", "文档", "研究"];

/** Byte budget kept below the service's own `maxTitleBytes` (80) so the
 * convention prefix is never the part that gets truncated. */
const TITLE_BYTE_BUDGET = 78;

/** Loader schema. Every field has a default, so the mount needs no config. */
const Config = z.object({
	/** Optional explicit title route; both fields together or neither. */
	provider: z.string(),
	model: z.string(),
	/** How many trailing human messages the title model sees. */
	maxSourceMessages: z.number().step(1).min(1).default(8),
	/** Hard input byte cap for the framed message JSON. */
	maxInputBytes: z.number().step(1).min(1).default(8192),
	/** Output cap for the auxiliary title call. */
	maxOutputTokens: z.number().step(1).min(1).default(96),
	/** Deadline for one auxiliary title call. */
	timeoutMs: z.number().step(1).min(1).default(60000),
	/** Topic length cap, counted in code points. */
	maxTopicCharacters: z.number().step(1).min(1).default(20),
	/**
	 * Sessions whose manual title pin is released on their next turn end.
	 * A manual rename pins a session out of automatic titling for good; listing
	 * its id here hands it back to this provider exactly once, after which
	 * ordinary per-turn cadence takes over again.
	 */
	unpinSessions: z.array(z.string()).default([]),
	/**
	 * Re-title after every completed turn. The service's own `all-prompts`
	 * cadence cannot be relied on here: it only starts a generation once the
	 * turn's request route is logged, and a long-lived session logs one
	 * `request/header` per series — not one per turn. A fresh header-less turn
	 * satisfies neither the header path nor the step-boundary fallback, so the
	 * title would silently stop updating. This provider therefore drives the
	 * documented explicit-refresh path from the turn boundary instead.
	 */
	afterEveryTurn: z.boolean().default(true)
});

/** Shanghai `MMDD` for one epoch-millisecond instant, without locale surprises. */
function shanghaiMonthDay(ms) {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: "Asia/Shanghai",
			month: "2-digit",
			day: "2-digit"
		}).formatToParts(new Date(ms));
		const month = parts.find((part) => part.type === "month")?.value;
		const day = parts.find((part) => part.type === "day")?.value;
		if (month !== undefined && day !== undefined) return `${month}${day}`;
	} catch {
		/* fall through to the host-local derivation below */
	}
	const fallback = new Date(ms);
	return `${String(fallback.getMonth() + 1).padStart(2, "0")}${String(fallback.getDate()).padStart(2, "0")}`;
}

/** The session's own start instant: its first human message, else now. */
function sessionStartMs(session) {
	for (const event of session.snapshotEvents()) {
		if (event.type !== "user/message") continue;
		if (event.data?.source?.kind !== "user") continue;
		if (typeof event.time === "number") return event.time;
	}
	return Date.now();
}

/** The convention instruction: the date is precomputed, the model judges the rest. */
function systemPrompt(mmdd, maxTopicCharacters) {
	return [
		"你是会话标题生成器。阅读给定的对话内容，输出恰好一行标题，格式为：MMDD｜类型｜主题",
		`MMDD 固定为 ${mmdd}，必须原样放在开头，不要改动、不要补年份。`,
		`类型 必须从这八个词里选恰好一个：${CATEGORIES.join("、")}。`,
		`主题 用简体中文概括这段对话的实际内容，不超过 ${maxTopicCharacters} 个字符；不要出现工作区名、项目名、目录名、文件名，也不要重复类型词。`,
		"分隔符使用全角竖线 ｜（U+FF5C）。",
		"只输出标题本身：不要引号、不要 Markdown、不要前后缀、不要解释、不要句末标点、不要换行。"
	].join("\n");
}

/** Frame the exact source messages as JSON so user text cannot break delimiters. */
function frameMessages(messages) {
	return `会话内容（JSON 数组，按时间顺序，字段 seq 为事件序号、text 为人类消息原文）：\n${JSON.stringify(
		messages.map((message) => ({ seq: message.seq, text: message.text }))
	)}`;
}

/** Rebuild a compliant title from raw model output, or `undefined` when it cannot. */
function conventionTitle(raw, mmdd, maxTopicCharacters) {
	const normalized = normalizeSessionTitle(raw, 400).replace(/[|｜]/gu, "｜");
	const match = normalized.match(
		new RegExp(`(${CATEGORIES.join("|")})\\s*｜\\s*(.+)$`, "u")
	);
	if (match === null) return undefined;
	const category = match[1];
	const topic = match[2]
		.replace(/^[「『"'`（(【\s]+/u, "")
		.replace(/[」』"'`）)】\s]+$/u, "")
		.replace(/[。．.,，;；:：!！?？]+$/u, "")
		.trim();
	if (topic.length === 0) return undefined;
	const characters = [...topic];
	const capped = characters.length > maxTopicCharacters ? characters.slice(0, maxTopicCharacters).join("") : topic;
	const title = normalizeSessionTitle(`${mmdd}｜${category}｜${capped}`, TITLE_BYTE_BUDGET);
	return title.length === 0 ? undefined : title;
}

/** Translate a terminal stream finish into a failure, or return on `stop`. */
function assertStopped(finish) {
	if (finish.kind === "stop") return;
	if (finish.kind === "error" || finish.kind === "aborted") {
		throw new Error(`${name}: title call failed: ${finish.failure.message}`);
	}
	throw new Error(`${name}: title call finished with "${String(finish.kind)}"`);
}

/** Generate one title for the message snapshot the service handed us. */
async function generateTitle(ctx, config, request) {
	request.signal.throwIfAborted();
	const source = request.messages.slice(-config.maxSourceMessages);
	if (source.length === 0) throw new Error(`${name}: no human message is available for a title`);
	const framed = frameMessages(source);
	if (Buffer.byteLength(framed, "utf8") > config.maxInputBytes) {
		throw new Error(`${name}: title input exceeds maxInputBytes ${config.maxInputBytes}`);
	}
	const route =
		config.provider !== undefined && config.model !== undefined
			? { provider: config.provider, model: config.model }
			: request.route;
	if (route === undefined) {
		throw new Error(`${name}: no logged request route is available; configure provider and model together`);
	}
	const mmdd = shanghaiMonthDay(sessionStartMs(request.session));
	const messages = [
		createUserMessage({
			content: [{ type: "text", text: framed }],
			source: { kind: "plugin", plugin: name }
		})
	];
	const signal = AbortSignal.any([request.signal, AbortSignal.timeout(config.timeoutMs)]);
	const options = deepFreeze({
		provider: route.provider,
		model: route.model,
		messages,
		system: systemPrompt(mmdd, config.maxTopicCharacters),
		maxTokens: config.maxOutputTokens,
		sessionId: request.session.id,
		purpose: "session-title",
		signal
	});
	const assembler = new BlockAssembler();
	for await (const chunk of ctx.llm.stream(options)) {
		signal.throwIfAborted();
		assembler.push(chunk);
	}
	signal.throwIfAborted();
	assertStopped(assembler.finish);
	const blocks = assembler.blocks();
	if (blocks.some((block) => block.type === "tool-call")) {
		throw new Error(`${name}: title output must contain text only`);
	}
	const raw = blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(" ");
	const title = conventionTitle(raw, mmdd, config.maxTopicCharacters);
	if (title === undefined) throw new Error(`${name}: output did not match the MMDD｜类型｜主题 convention`);
	return { title, messageSeqs: source.map((message) => message.seq), model: route };
}

/**
 * Re-title on the turn boundary, honoring a manual pin.
 *
 * `refresh()` is the service's documented explicit path: it regenerates from
 * the human messages already logged, independent of the route bookkeeping the
 * automatic cadence needs. A session whose title was renamed by hand stays
 * pinned and is skipped unless it is listed in `unpinSessions`, which releases
 * exactly one pin and then stops applying.
 */
function watchTurns(ctx, config) {
	if (!config.afterEveryTurn && config.unpinSessions.length === 0) return;
	const pinnedOut = new Set(config.unpinSessions);
	ctx.on("session/event", (session, event) => {
		if (event.type !== "turn/end") return;
		const wantsUnpin = pinnedOut.has(session.id);
		if (!wantsUnpin && !config.afterEveryTurn) return;
		if (!wantsUnpin && ctx.sessionTitle.get(session)?.source.kind === "user") return;
		void ctx.sessionTitle
			.refresh(session)
			.then(() => {
				if (wantsUnpin) pinnedOut.delete(session.id);
			})
			.catch((error) => {
				ctx.logger?.warn(`${name}: title refresh for "${session.id}" failed: ${String(error)}`);
			});
	});
}

/**
 * Register the convention provider.
 * @param ctx - context exposing session-title, LLM, and session services.
 * @param config - resolved loader configuration.
 */
function apply(ctx, config) {
	ctx.sessionTitle.register({
		id: name,
		automatic: "first-prompt",
		generate: (request) => generateTitle(ctx, config, request)
	});
	watchTurns(ctx, config);
}

export { Config, apply, inject, name };
