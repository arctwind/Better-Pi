import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function withoutThinking(message: AgentMessage): AgentMessage {
	if (message.role !== "assistant") return message;

	const content = message.content.filter((block) => block.type !== "thinking");
	return content.length === message.content.length ? message : { ...message, content };
}

export default function compactionThinking(pi: ExtensionAPI): void {
	pi.on("session_before_compact", ({ preparation }) => {
		const messagesToSummarize = preparation.messagesToSummarize.map(withoutThinking);
		const turnPrefixMessages = preparation.turnPrefixMessages.map(withoutThinking);

		preparation.messagesToSummarize = messagesToSummarize;
		preparation.turnPrefixMessages = turnPrefixMessages;
	});
}
