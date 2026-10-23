import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTABLE_TYPES = new Set([".exe", ".com", ".bat", ".cmd", ".msi", ".scr", ".lnk", ".url", ".app", ".desktop"]);
const DOCUMENT_TYPES = new Set([".html", ".htm", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mp4", ".webm", ".mp3", ".wav", ".ogg", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"]);

function resolveTarget(value, cwd) {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f]/.test(value)) throw new Error("Invalid file path");
  const input = value.startsWith("file:") ? fileURLToPath(value) : value;
  if (/^(?:\\\\|\/\/)/.test(input)) throw new Error("Network file paths are not supported");
  return resolve(cwd, input.replace(/^~(?=[/\\]|$)/, homedir()));
}

async function statDirectory(path) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Directory not found: ${path}`);
    if (error?.code === "EACCES" || error?.code === "EPERM") throw new Error(`Permission denied: ${path}`);
    throw error;
  }
  if (!info.isDirectory()) throw new Error(`Directory not found: ${path}`);
  return info;
}

export async function resolveOpenPath(value, cwd, { allowExecutable = false } = {}) {
  const target = resolveTarget(value, cwd);
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`File not found: ${target}`);
    if (error?.code === "EACCES" || error?.code === "EPERM") throw new Error(`Permission denied: ${target}`);
    throw error;
  }
  if (!info.isFile() && !info.isDirectory()) throw new Error("This file cannot be opened");
  if (!allowExecutable && info.isFile() && EXECUTABLE_TYPES.has(extname(target).toLowerCase())) throw new Error("Executables cannot be run from a message");
  return { target, isDirectory: info.isDirectory() };
}

export async function resolveRevealPath(value, cwd) {
  const target = resolveTarget(value, cwd);
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      const parent = dirname(target);
      await statDirectory(parent);
      return { target: parent, isDirectory: true };
    }
    if (error?.code === "EACCES" || error?.code === "EPERM") throw new Error(`Permission denied: ${target}`);
    throw error;
  }
  if (!info.isFile() && !info.isDirectory()) throw new Error("This file cannot be opened");
  return { target, isDirectory: info.isDirectory() };
}

async function revealInFileManager(target, isDirectory) {
  let command;
  let args;
  const options = { windowsHide: true, stdio: "ignore" };
  if (process.platform === "win32") {
    command = "explorer.exe";
    options.windowsHide = false;
    if (isDirectory) {
      args = [target];
    } else {
      args = [`/select,"${target}"`];
      options.windowsVerbatimArguments = true;
    }
  } else if (process.platform === "darwin") {
    command = "open";
    args = isDirectory ? [target] : ["-R", target];
  } else {
    command = "xdg-open";
    args = [isDirectory ? target : dirname(target)];
  }
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

async function openContainingFolder(value, cwd) {
  const { target, isDirectory } = await resolveRevealPath(value, cwd);
  await revealInFileManager(target, isDirectory);
}

export async function openLocalPath(value, cwd, { useDefaultApp = false, mode = "open" } = {}) {
  if (mode === "folder") {
    await openContainingFolder(value, cwd);
    return;
  }
  const { target, isDirectory } = await resolveOpenPath(value, cwd);
  const isCode = !useDefaultApp && !isDirectory && !DOCUMENT_TYPES.has(extname(target).toLowerCase());
  let command;
  let args;
  if (process.platform === "win32") {
    command = isCode ? "notepad.exe" : "powershell.exe";
    args = isCode ? [target] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:PI_WEBUI_OPEN_PATH -ErrorAction Stop"];
  } else {
    command = process.platform === "darwin" ? "open" : "xdg-open";
    args = process.platform === "darwin" && isCode ? ["-t", target] : [target];
  }
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore", env: { ...process.env, PI_WEBUI_OPEN_PATH: target } });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Could not open the file")));
    if (isCode || process.platform !== "win32") child.once("spawn", () => { child.unref(); resolve(); });
  });
}
