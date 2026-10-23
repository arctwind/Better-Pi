import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";

const FAST_WHEEL_LINES = 5;
const ALT_WHEEL_LINES = 1;
const ALT_MODIFIER_BIT = 8;

export default function (_pi: ExtensionAPI) {
	const proto = TuiAltScreen.prototype as unknown as {
		getWheelScrollLines?: (button: number) => number;
	};
	if (typeof proto.getWheelScrollLines !== "function") throw new Error("Better Pi requires TuiAltScreen.getWheelScrollLines().");
	proto.getWheelScrollLines = (button: number) =>
		(button & ALT_MODIFIER_BIT) !== 0 ? ALT_WHEEL_LINES : FAST_WHEEL_LINES;
}
