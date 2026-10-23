import { readdir } from "node:fs/promises";
import { join } from "node:path";

const IGNORED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".next", ".nuxt", ".cache", ".turbo", ".parcel-cache",
  "node_modules", "dist", "build", "out", "target", "coverage", ".venv", "venv", "__pycache__",
]);
const MAX_ENTRIES = 6000;
const MAX_RESULTS = 40;
const CACHE_TTL_MS = 5000;
let cache;

function isSubsequence(query, text) {
  let index = 0;
  for (const character of text) {
    if (character === query[index]) index++;
    if (index === query.length) return true;
  }
  return query.length === 0;
}

function matchScore(path, query) {
  if (!query) return 0;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base === query) return 0;
  if (base.startsWith(query)) return 1;
  if (path.startsWith(query)) return 2;
  if (base.includes(query)) return 3;
  if (path.includes(query)) return 4;
  return isSubsequence(query, path) ? 5 : -1;
}

async function collectEntries(cwd) {
  const entries = [];
  const queue = [""];
  while (queue.length && entries.length < MAX_ENTRIES) {
    const directory = queue.shift();
    let children;
    try { children = await readdir(join(cwd, directory), { withFileTypes: true }); }
    catch { continue; }
    for (const child of children) {
      if (entries.length >= MAX_ENTRIES) break;
      const isDirectory = child.isDirectory();
      if (isDirectory && (child.name.startsWith(".") || IGNORED_DIRECTORIES.has(child.name))) continue;
      const path = directory ? `${directory}/${child.name}` : child.name;
      entries.push({ path, type: isDirectory ? "dir" : "file" });
      if (isDirectory) queue.push(path);
    }
  }
  return entries;
}

async function getEntries(cwd, now) {
  if (!cache || cache.cwd !== cwd || now - cache.at > CACHE_TTL_MS) {
    cache = { cwd, at: now, promise: collectEntries(cwd) };
  }
  return cache.promise;
}

export async function listFiles(cwd, query, { now = Date.now() } = {}) {
  const normalized = String(query ?? "").slice(0, 200).replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const entries = await getEntries(cwd, now);
  const matches = [];
  for (const entry of entries) {
    const score = matchScore(entry.path.toLowerCase(), normalized);
    if (score >= 0) matches.push({ entry, score });
  }
  matches.sort((left, right) =>
    left.score - right.score ||
    left.entry.path.length - right.entry.path.length ||
    left.entry.path.localeCompare(right.entry.path));
  return matches.slice(0, MAX_RESULTS).map(({ entry }) => entry);
}

export function clearFileCache() {
  cache = undefined;
}
