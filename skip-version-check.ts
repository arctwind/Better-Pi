import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const previous = process.env.PI_SKIP_VERSION_CHECK;
	process.env.PI_SKIP_VERSION_CHECK = "1";
	pi.on("session_shutdown", () => {
		if (previous === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
		else process.env.PI_SKIP_VERSION_CHECK = previous;
	});
}
