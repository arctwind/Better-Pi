import { isAbsolute, relative, sep } from "node:path";

export function isWithinDirectory(root: string, target: string): boolean {
	const path = relative(root, target);
	return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
