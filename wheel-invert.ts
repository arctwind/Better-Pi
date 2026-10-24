import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";

const FAST_WHEEL_LINES = 5;
const ALT_WHEEL_LINES = 1;
const ALT_MODIFIER_BIT = 8;

export default function (pi: ExtensionAPI) {
	const proto = TuiAltScreen.prototype as unknown as {
		getWheelScrollLines?: (button: number) => number;
	};
	if (typeof proto.getWheelScrollLines !== "function") throw new Error("Better Pi requires TuiAltScreen.getWheelScrollLines().");
	const previous = proto.getWheelScrollLines;
	const getWheelScrollLines = (button: number) =>
		(button & ALT_MODIFIER_BIT) !== 0 ? ALT_WHEEL_LINES : FAST_WHEEL_LINES;
	proto.getWheelScrollLines = getWheelScrollLines;
	pi.on("session_shutdown", ({ reason }) => {
		if (reason !== "reload" && reason !== "quit") return;
		if (proto.getWheelScrollLines === getWheelScrollLines) proto.getWheelScrollLines = previous;
	});
}
