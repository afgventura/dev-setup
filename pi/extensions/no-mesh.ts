/**
 * Keep pi sessions from talking to each other through remote-pi's "agent
 * network" (mesh).
 *
 * remote-pi puts every session on a local broker and gives the model
 * `agent_send` / `agent_request` / `list_peers` plus a skill that encourages
 * using them. One session doing `agent_send(to: "broadcast", …)` then lands
 * in every other session as a `[remote-pi:mesh-message]` that *starts a
 * model turn there* — a dozen sessions each burning a turn on someone else's
 * status update. We only want remote-pi for the phone app, so:
 *   - block the sending tools (the model gets a clear reason back), and
 *   - drop any mesh message that still arrives from the model's context so
 *     the wasted turn at least carries nothing new.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BLOCKED = new Set(["agent_send", "agent_request", "list_peers"]);

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (!BLOCKED.has(event.toolName)) return;
		return {
			block: true,
			reason:
				`${event.toolName} is disabled in this setup: sessions do not message each other over the remote-pi mesh. ` +
				"Report to the user instead.",
		};
	});

	pi.on("context", async (event) => ({
		messages: event.messages.filter(
			(m: any) => !(m.role === "custom" && m.customType === "remote-pi:mesh-message"),
		),
	}));
}
