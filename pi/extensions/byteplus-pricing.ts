/**
 * byteplus-pricing — time-of-day (peak / off-peak) cost accounting.
 *
 * pi's models.json has exactly one cost-tier dimension (`inputTokensAbove`,
 * a request-size threshold). There is no time dimension in the schema, so
 * peak/off-peak cannot be expressed declaratively. This extension adds it:
 * `message_end` can return a replacement message, and the cost written there
 * is what lands in the session JSONL and what the footer totals read.
 *
 * Ordering matters and works in our favour: the models layer runs its own
 * `calculateCost` at stream end, *before* `message_end` fires, so whatever
 * we write here is last-write-wins.
 *
 * Billing period: BytePlus charges by the period in which the REQUEST was
 * made, not when the response finished. So the rate is chosen from the
 * timestamp captured in `before_provider_request`, not from the assistant
 * message's own timestamp (which is the completion time). A request that
 * starts 11:59:58 and finishes 12:00:05 is billed at peak.
 *
 * Rates are per MILLION tokens, and are informational only — this makes pi
 * *report* the right number. It does not change what BytePlus bills you.
 *
 *   /pricing    show the active window and which rate set is in effect
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

/**
 * Timezone the peak window is expressed in. The BytePlus definition is
 * UTC+8; Asia/Singapore and Asia/Shanghai are both fixed UTC+8 (no DST),
 * so either is exact.
 */
const TZ = "Asia/Singapore";

/**
 * PEAK windows, in TZ local time, as [start, end) "HH:MM".
 * Everything outside these windows is off-peak. A window whose end <= start
 * wraps past midnight (neither of these does, but the check is generic).
 *
 * BytePlus: Monday–Friday, 09:00–12:00 and 14:00–18:00 (UTC+8).
 * Note the 12:00–14:00 lunch gap is OFF-peak, as are weekends.
 */
const PEAK_WINDOWS: Array<[string, string]> = [
	["09:00", "12:00"],
	["14:00", "18:00"],
];

/** Days that can ever be peak. Anything not listed is off-peak all day. */
const PEAK_DAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

/**
 * Which providers to price. Keyed by pi's provider id (`message.provider`).
 *
 * Rate order in the BytePlus console listing is input / cache-hit / output.
 * cacheWrite is not published separately; the usual convention is that
 * writing cache costs the normal (cache-miss) input rate, which is what we
 * assume here. Change it if your invoice disagrees.
 */
const PROVIDERS: Record<string, { peak: Rates; offPeak: Rates }> = {
	byteplus: {
		peak: { input: 0.12, cacheRead: 0.006, cacheWrite: 0.12, output: 0.48 },
		offPeak: { input: 0.06, cacheRead: 0.003, cacheWrite: 0.06, output: 0.24 },
	},
};

// ---------------------------------------------------------------------------

interface Rates {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
}

const toMinutes = (hhmm: string): number => {
	const [h, m] = hhmm.split(":").map(Number);
	return (h ?? 0) * 60 + (m ?? 0);
};

/** Local wall-clock parts in TZ, without pulling in a date library. */
function localParts(ts: number): { minutes: number; weekday: string } {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: TZ,
		hour12: false,
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
	}).formatToParts(new Date(ts));
	const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
	// Some engines emit "24" for midnight under hour12:false.
	const hour = Number(get("hour")) % 24;
	return { minutes: hour * 60 + Number(get("minute")), weekday: get("weekday") };
}

function isPeak(ts: number): boolean {
	const { minutes, weekday } = localParts(ts);
	if (!PEAK_DAYS.has(weekday)) return false;
	return PEAK_WINDOWS.some(([start, end]) => {
		const s = toMinutes(start);
		const e = toMinutes(end);
		return s <= e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
	});
}

const ratesFor = (providerId: string, ts: number): Rates | undefined => {
	const entry = PROVIDERS[providerId];
	if (!entry) return undefined;
	return isPeak(ts) ? entry.peak : entry.offPeak;
};

/** Mirrors pi's own calculateCost, minus the (unused) size tiers. */
function priceUsage(usage: any, rates: Rates): void {
	const per = (n: number, rate: number): number => ((n || 0) / 1e6) * rate;
	const cost = usage.cost ?? {};
	cost.input = per(usage.input, rates.input);
	cost.output = per(usage.output, rates.output);
	cost.cacheRead = per(usage.cacheRead, rates.cacheRead);
	cost.cacheWrite = per(usage.cacheWrite, rates.cacheWrite);
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	usage.cost = cost;
}

export default function (pi: ExtensionAPI) {
	// When the request currently in flight was sent. This is the billing
	// moment, and it is what decides peak vs off-peak.
	let requestAt: number | undefined;

	pi.on("before_provider_request", () => {
		requestAt = Date.now();
	});

	pi.on("message_end", async (event) => {
		const message: any = event.message;
		if (message?.role !== "assistant" || !message.usage) return;

		// Consume the in-flight request time; fall back to the message's own
		// timestamp if this response did not go through the provider hook.
		const at = requestAt ?? message.timestamp ?? Date.now();
		requestAt = undefined;

		const rates = ratesFor(message.provider, at);
		if (!rates) return;
		// Never rewrite a failed/empty response into a phantom cost.
		if (!message.usage.totalTokens) return;

		priceUsage(message.usage, rates);
		return { message };
	});

	pi.registerCommand("pricing", {
		description: "Show the active peak/off-peak rate set",
		handler: async (_args, ctx) => {
			const ts = Date.now();
			const now = new Intl.DateTimeFormat("en-GB", {
				timeZone: TZ,
				dateStyle: "medium",
				timeStyle: "short",
			}).format(new Date(ts));
			const peak = isPeak(ts);
			const lines = [`${now} ${TZ} — ${peak ? "PEAK" : "OFF-PEAK"}`];
			for (const [providerId, entry] of Object.entries(PROVIDERS)) {
				const r = peak ? entry.peak : entry.offPeak;
				lines.push(
					`${providerId}: in ${r.input} / cacheRead ${r.cacheRead} / cacheWrite ${r.cacheWrite} / out ${r.output}  (per M)`,
				);
			}
			lines.push(
				`peak: ${[...PEAK_DAYS].join(",")} ${PEAK_WINDOWS.map(([s, e]) => `${s}-${e}`).join(" and ")} ${TZ}`,
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
