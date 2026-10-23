import { createRequire } from "node:module";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

export function loadPiDependency<T>(name: "diff" | "proper-lockfile"): T {
	return createRequire(join(getPackageDir(), "package.json"))(name) as T;
}
