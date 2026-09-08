#!/usr/bin/env node

// src/codex-hook.ts
import { execFile as execFile2 } from "node:child_process";
import { realpath as realpath3 } from "node:fs/promises";
import { stdin } from "node:process";
import { promisify as promisify2 } from "node:util";

// src/results.ts
function message(error) {
  return error instanceof Error ? error.message : String(error);
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function number(value, fallback, min = 0, max = 1e4) {
  if (value === void 0) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`Expected integer ${min}..${max}`);
  return value;
}
function render(results, limit = 50, byteLimit = 8192, offset = 0) {
  const lines = [
    ...new Set(
      results.flatMap((result) => [
        ...result.findings.map(
          (finding) => `${finding.path}:${finding.line}:${finding.column} ${finding.severity} [${finding.source}] ${finding.message.replace(/\s+/g, " ")}`
        ),
        ...result.state === "complete" ? [] : [
          `${result.path} ${result.state}${result.note ? `: ${result.note.replace(/\s+/g, " ").slice(0, 300)}` : ""}`
        ]
      ])
    )
  ].sort((a, b) => a.localeCompare(b));
  const complete = results.every((result) => result.state === "complete");
  const header = `${complete ? "complete" : "partial"}; checked=${results.filter((result) => result.state === "complete").length} pending=${results.filter((result) => result.state === "pending" || result.state === "stale").length} skipped=${results.filter((result) => result.state === "skipped").length} failed=${results.filter((result) => result.state === "failed").length}`;
  let output = header;
  let shown = 0;
  for (const line of lines.slice(offset, offset + limit)) {
    const clipped = line.slice(0, 1e3);
    if (Buffer.byteLength(output + clipped) > byteLimit - 180) break;
    output += `
${clipped}`;
    shown++;
  }
  if (offset + shown < lines.length)
    output += `
${lines.length - offset - shown} omitted; next offset=${offset + shown}`;
  return output;
}

// src/worker.ts
import { spawn as spawn4 } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat as lstat2, mkdir, readFile as readFile6, realpath as realpath2, rm, writeFile as writeFile4 } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { homedir as homedir3, tmpdir } from "node:os";
import { isAbsolute as isAbsolute4, join as join10 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/engine.ts
import { readFile as readFile5, stat, writeFile as writeFile3 } from "node:fs/promises";
import { relative as relative4, sep as sep3 } from "node:path";

// src/files.ts
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
var exec = promisify(execFile);
var SKIP = /* @__PURE__ */ new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".canon",
  ".venv",
  ".ruff_cache",
  ".mypy_cache",
  ".pytest_cache",
  "__pycache__",
  "vendor",
  "target"
]);
var hash = (text2) => createHash("sha256").update(text2).digest("hex");
function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
async function workspacePath(root, path) {
  const absolute = resolve(root, path);
  if (!inside(root, absolute)) throw new Error("Path is outside workspace");
  const actual = await realpath(absolute);
  if (!inside(root, actual)) throw new Error("Symlink is outside workspace");
  return actual;
}
async function inventory(root, maxFiles = 1e4) {
  let names;
  let complete = true;
  try {
    const { stdout } = await exec(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
      { cwd: root, timeout: 5e3, maxBuffer: 4 * 1024 * 1024 }
    );
    names = [...new Set(stdout.split("\0").filter(Boolean))];
  } catch {
    names = [];
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (names.length >= maxFiles) {
          complete = false;
          break;
        }
        if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) names.push(relative(root, path));
      }
    };
    await walk(root);
  }
  const files = /* @__PURE__ */ new Map();
  names.sort();
  if (names.length > maxFiles) complete = false;
  for (const name of names.slice(0, maxFiles)) {
    if (name.split(/[\\/]/).some((part) => SKIP.has(part))) continue;
    try {
      const path = await workspacePath(root, name);
      const stat2 = await lstat(path);
      if (!stat2.isFile()) continue;
      if (stat2.size > 1024 * 1024) {
        complete = false;
        continue;
      }
      files.set(relative(root, path), hash(await readFile(path, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) complete = false;
    }
  }
  return { files, version: hash(JSON.stringify([...files])), complete };
}
function applyTextChanges(text2, edits) {
  const lines = text2.split("\n");
  const offset = (line, character) => {
    if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0 || line >= lines.length || character > (lines[line]?.length ?? 0))
      throw new Error("Invalid edit range");
    return lines.slice(0, line).reduce((n, part) => n + part.length + 1, 0) + character;
  };
  const sorted = edits.map((edit) => ({
    start: offset(edit.range.start.line, edit.range.start.character),
    end: offset(edit.range.end.line, edit.range.end.character),
    text: edit.newText
  })).sort((a, b) => b.start - a.start || b.end - a.end);
  let boundary = text2.length;
  for (const edit of sorted) {
    if (edit.start > edit.end || edit.end > boundary) throw new Error("Overlapping edit ranges");
    text2 = text2.slice(0, edit.start) + edit.text + text2.slice(edit.end);
    boundary = edit.start;
  }
  return text2;
}

// src/language.ts
import { readFile as readFile3, writeFile } from "node:fs/promises";
import { extname as extname3, relative as relative3, resolve as resolve5 } from "node:path";
import { fileURLToPath, pathToFileURL as pathToFileURL3 } from "node:url";

// packages/lsp-tools-mcp/dist/lsp/client.js
import { readFileSync } from "node:fs";
import { extname, resolve as resolve2 } from "node:path";
import { pathToFileURL as pathToFileURL2 } from "node:url";

// packages/lsp-tools-mcp/dist/lsp/connection.js
import { pathToFileURL } from "node:url";

// packages/lsp-tools-mcp/dist/lsp/transport.js
import { delimiter as delimiter3 } from "node:path";

// packages/lsp-tools-mcp/dist/lsp/cleanup-errors.js
function reportBestEffortCleanupError(operation, error) {
  if (process.env["CODEX_LSP_DEBUG_CLEANUP"] !== "1")
    return;
  const message2 = error instanceof Error ? error.message : String(error);
  console.error(`[codex-lsp] ignored ${operation} failure during cleanup: ${message2}`);
}

// packages/lsp-tools-mcp/dist/lsp/constants.js
var REQUEST_TIMEOUT_MS = 15e3;
var INIT_TIMEOUT_MS = 6e4;
var IDLE_TIMEOUT_MS = 5 * 6e4;
var REAPER_INTERVAL_MS = 6e4;
var STOP_HARD_KILL_TIMEOUT_MS = 5e3;
var STOP_SIGKILL_GRACE_MS = 1e3;

// packages/lsp-tools-mcp/dist/lsp/errors.js
var LspConnectionClosedError = class extends Error {
  constructor(serverId, root, message2) {
    super(message2 ?? `LSP connection closed for ${serverId} at ${root}`);
    this.serverId = serverId;
    this.root = root;
    this.name = "LspConnectionClosedError";
  }
};
var LspProcessExitedError = class extends Error {
  constructor(serverId, root, exitCode, stderrTail) {
    const stderrSuffix = stderrTail ? `
stderr tail: ${stderrTail}` : "";
    super(`LSP server ${serverId} at ${root} exited with code ${exitCode ?? "null"}${stderrSuffix}`);
    this.serverId = serverId;
    this.root = root;
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
    this.name = "LspProcessExitedError";
  }
};
var LspRequestTimeoutError = class extends Error {
  constructor(method, stderrTail) {
    const stderrSuffix = stderrTail ? `
recent stderr: ${stderrTail}` : "";
    super(`LSP request timeout (method: ${method})${stderrSuffix}`);
    this.method = method;
    this.stderrTail = stderrTail;
    this.name = "LspRequestTimeoutError";
  }
};
var LspInvalidPathError = class extends Error {
  constructor() {
    super(...arguments);
    this.name = "LspInvalidPathError";
  }
};
var LspServerLookupError = class extends Error {
  constructor() {
    super(...arguments);
    this.name = "LspServerLookupError";
  }
};
var LspServerInitializingError = class extends Error {
  constructor(originalError) {
    super(`LSP server is still initializing. Please retry in a few seconds. Original error: ${originalError.message}`);
    this.originalError = originalError;
    this.name = "LspServerInitializingError";
  }
};
var LspProcessSpawnError = class extends Error {
  constructor() {
    super(...arguments);
    this.name = "LspProcessSpawnError";
  }
};
function isLspDeadConnectionError(err) {
  return err instanceof LspConnectionClosedError || err instanceof LspProcessExitedError;
}

// packages/lsp-tools-mcp/dist/lsp/json-rpc-connection.js
var HEADER_SEPARATOR = "\r\n\r\n";
var PARSE_ERROR = -32700;
var INVALID_REQUEST = -32600;
var METHOD_NOT_FOUND = -32601;
var INTERNAL_ERROR = -32603;
var JsonRpcConnection = class {
  constructor(reader, writer) {
    this.reader = reader;
    this.writer = writer;
    this.pendingRequests = /* @__PURE__ */ new Map();
    this.notificationHandlers = /* @__PURE__ */ new Map();
    this.requestHandlers = /* @__PURE__ */ new Map();
    this.closeHandlers = [];
    this.errorHandlers = [];
    this.inputBuffer = Buffer.alloc(0);
    this.nextRequestId = 1;
    this.listening = false;
    this.disposed = false;
    this.handleData = (chunk) => {
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      this.inputBuffer = Buffer.concat([this.inputBuffer, chunkBuffer]);
      this.drainInputBuffer();
    };
    this.handleClose = () => {
      for (const handler of this.closeHandlers) {
        handler();
      }
    };
    this.handleStreamError = (error) => {
      this.emitError(error);
    };
  }
  listen() {
    if (this.listening)
      return;
    this.listening = true;
    this.reader.on("data", this.handleData);
    this.reader.on("close", this.handleClose);
    this.reader.on("end", this.handleClose);
    this.reader.on("error", this.handleStreamError);
    this.writer.on("error", this.handleStreamError);
  }
  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }
  onRequest(method, handler) {
    this.requestHandlers.set(method, handler);
  }
  onClose(handler) {
    this.closeHandlers.push(handler);
  }
  onError(handler) {
    this.errorHandlers.push(handler);
  }
  async sendRequest(method, params) {
    if (this.disposed)
      throw new Error("JSON-RPC connection is disposed");
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const message2 = params === void 0 ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
    const responsePromise = new Promise((resolve6, reject) => {
      this.pendingRequests.set(String(id), {
        resolve(result) {
          resolve6(result);
        },
        reject
      });
    });
    try {
      await this.writeMessage(message2);
    } catch (error) {
      this.pendingRequests.delete(String(id));
      throw error;
    }
    return responsePromise;
  }
  async sendNotification(method, params) {
    if (this.disposed)
      return;
    const message2 = params === void 0 ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    await this.writeMessage(message2);
  }
  dispose() {
    if (this.disposed)
      return;
    this.disposed = true;
    this.reader.off("data", this.handleData);
    this.reader.off("close", this.handleClose);
    this.reader.off("end", this.handleClose);
    this.reader.off("error", this.handleStreamError);
    this.writer.off("error", this.handleStreamError);
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error("JSON-RPC connection disposed"));
    }
    this.pendingRequests.clear();
    this.notificationHandlers.clear();
    this.requestHandlers.clear();
  }
  drainInputBuffer() {
    while (true) {
      const headerEnd = this.inputBuffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1)
        return;
      const headers = this.inputBuffer.subarray(0, headerEnd).toString("ascii");
      const contentLength = parseContentLength(headers);
      if (contentLength === null) {
        this.inputBuffer = Buffer.alloc(0);
        this.emitError(new Error("JSON-RPC message is missing Content-Length header"));
        return;
      }
      const bodyStart = headerEnd + Buffer.byteLength(HEADER_SEPARATOR);
      const bodyEnd = bodyStart + contentLength;
      if (this.inputBuffer.length < bodyEnd)
        return;
      const body = this.inputBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.inputBuffer = this.inputBuffer.subarray(bodyEnd);
      this.dispatchBody(body);
    }
  }
  dispatchBody(body) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      void this.writeError(null, PARSE_ERROR, error instanceof Error ? error.message : "Parse error").catch((writeError) => this.emitError(toError(writeError)));
      return;
    }
    if (!isJsonRpcObject(parsed)) {
      void this.writeError(null, INVALID_REQUEST, "Invalid JSON-RPC message").catch((error) => this.emitError(toError(error)));
      return;
    }
    if ("id" in parsed && ("result" in parsed || "error" in parsed)) {
      this.handleResponse(parsed);
      return;
    }
    if (typeof parsed["method"] !== "string") {
      const id = getMessageId(parsed) ?? null;
      void this.writeError(id, INVALID_REQUEST, "Invalid JSON-RPC method").catch((error) => this.emitError(toError(error)));
      return;
    }
    if ("id" in parsed) {
      this.handleRequest(parsed);
      return;
    }
    this.handleNotification(parsed["method"], parsed["params"]);
  }
  handleResponse(message2) {
    const id = getMessageId(message2);
    if (id === void 0)
      return;
    const pending = this.pendingRequests.get(String(id));
    if (!pending)
      return;
    this.pendingRequests.delete(String(id));
    if ("error" in message2) {
      pending.reject(jsonRpcErrorToError(message2["error"]));
      return;
    }
    pending.resolve(message2["result"]);
  }
  handleNotification(method, params) {
    const handler = this.notificationHandlers.get(method);
    if (!handler)
      return;
    try {
      handler(params);
    } catch (error) {
      this.emitError(toError(error));
    }
  }
  handleRequest(message2) {
    const id = getMessageId(message2);
    if (id === void 0) {
      void this.writeError(null, INVALID_REQUEST, "Invalid JSON-RPC id").catch((error) => this.emitError(toError(error)));
      return;
    }
    const method = typeof message2["method"] === "string" ? message2["method"] : "";
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      void this.writeError(id, METHOD_NOT_FOUND, `Method not found: ${method}`).catch((error) => this.emitError(toError(error)));
      return;
    }
    Promise.resolve().then(() => handler(message2["params"])).then((result) => this.writeMessage({ jsonrpc: "2.0", id, result }), (error) => this.writeError(id, INTERNAL_ERROR, toError(error).message)).catch((error) => this.emitError(toError(error)));
  }
  async writeError(id, code, message2) {
    await this.writeMessage({ jsonrpc: "2.0", id, error: { code, message: message2 } });
  }
  writeMessage(message2) {
    const body = JSON.stringify(message2);
    const payload = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r
\r
${body}`;
    return new Promise((resolve6, reject) => {
      this.writer.write(payload, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve6();
      });
    });
  }
  emitError(error) {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }
};
function parseContentLength(headers) {
  for (const line of headers.split("\r\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1)
      continue;
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    if (name !== "content-length")
      continue;
    const value = Number.parseInt(line.slice(separatorIndex + 1).trim(), 10);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  return null;
}
function isJsonRpcObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function getMessageId(message2) {
  const id = message2["id"];
  if (typeof id === "number" || typeof id === "string" || id === null)
    return id;
  return void 0;
}
function jsonRpcErrorToError(value) {
  if (!isJsonRpcObject(value))
    return new Error("JSON-RPC request failed");
  const message2 = typeof value["message"] === "string" ? value["message"] : "JSON-RPC request failed";
  const error = new Error(message2);
  if (typeof value["code"] === "number") {
    error.name = `JsonRpcError(${value["code"]})`;
  }
  return error;
}
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

// packages/lsp-tools-mcp/dist/lsp/process.js
import * as childProcess from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join as join2 } from "node:path";
function isMissingProcessError(error) {
  if (!(error instanceof Error) || !("code" in error))
    return false;
  return error.code === "ESRCH";
}
function reportKillError(context, error) {
  if (!isMissingProcessError(error)) {
    reportBestEffortCleanupError(context, error);
  }
}
function validateCwd(cwd) {
  try {
    if (!existsSync(cwd)) {
      return { valid: false, error: `Working directory does not exist: ${cwd}` };
    }
    const stats = statSync(cwd);
    if (!stats.isDirectory()) {
      return { valid: false, error: `Path is not a directory: ${cwd}` };
    }
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: `Cannot access working directory: ${cwd} (${err instanceof Error ? err.message : String(err)})`
    };
  }
}
function wrap(proc) {
  const exitedPromise = new Promise((resolve6) => {
    proc.once("close", (code) => resolve6(code ?? 0));
    proc.once("error", () => resolve6(1));
  });
  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    throw new LspProcessSpawnError("Spawned process is missing one of stdin/stdout/stderr pipes");
  }
  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    get pid() {
      return proc.pid ?? void 0;
    },
    get exitCode() {
      return proc.exitCode;
    },
    get killed() {
      return proc.killed;
    },
    exited: exitedPromise,
    kill(signal) {
      terminateProcessTree(proc, signal ?? "SIGTERM");
    }
  };
}
function terminateProcessTree(proc, signal = "SIGTERM", options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && proc.pid) {
    const args = ["/pid", String(proc.pid), "/f", "/t"];
    const result = options.spawnSync === void 0 ? childProcess.spawnSync("taskkill", args, { stdio: "ignore" }) : options.spawnSync("taskkill", args, { stdio: "ignore" });
    if (!result.error && result.status === 0)
      return;
    if (result.error)
      reportKillError("windows process tree kill", result.error);
  }
  if (platform !== "win32" && proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch (error) {
      reportKillError("process group kill", error);
    }
    const descendants = findDescendantProcessIds(proc.pid);
    try {
      proc.kill(signal);
    } catch (error) {
      reportKillError("process kill", error);
    }
    for (const pid of descendants) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        reportKillError("descendant process kill", error);
      }
    }
    return;
  }
  try {
    proc.kill(signal);
  } catch (error) {
    reportKillError("process kill", error);
  }
}
function findDescendantProcessIds(rootPid) {
  const result = childProcess.spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  if (result.error) {
    reportKillError("process tree inspection", result.error);
    return [];
  }
  if (result.status !== 0 || typeof result.stdout !== "string")
    return [];
  const childrenByParent = /* @__PURE__ */ new Map();
  for (const line of result.stdout.split("\n")) {
    const [pidText, parentPidText] = line.trim().split(/\s+/, 2);
    if (pidText === void 0 || parentPidText === void 0)
      continue;
    const pid = Number(pidText);
    const parentPid = Number(parentPidText);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid))
      continue;
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  const descendants = [];
  const pendingParents = [rootPid];
  while (pendingParents.length > 0) {
    const parentPid = pendingParents.pop();
    if (parentPid === void 0)
      break;
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      descendants.push(childPid);
      pendingParents.push(childPid);
    }
  }
  return descendants.reverse();
}
function isWindowsShellShim(command) {
  const lowerCommand = command.toLowerCase();
  return lowerCommand.endsWith(".cmd") || lowerCommand.endsWith(".bat");
}
function splitPath(pathValue, platform) {
  const separator = platform === "win32" ? ";" : delimiter;
  return pathValue.split(separator).filter(Boolean);
}
function getWindowsPathExtensions(env) {
  const rawExtensions = env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";
  const extensions = rawExtensions.split(";").map((extension) => extension.trim()).filter(Boolean).map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  return [.../* @__PURE__ */ new Set(["", ...extensions, ".exe", ".cmd", ".bat"])];
}
function resolveWindowsCommand(command, env) {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  const pathValue = env["PATH"] ?? env["Path"] ?? "";
  const baseDirectories = hasPathSeparator ? [""] : splitPath(pathValue, "win32");
  const extensions = getWindowsPathExtensions(env);
  for (const baseDirectory of baseDirectories) {
    for (const extension of extensions) {
      const candidate = baseDirectory ? join2(baseDirectory, `${command}${extension}`) : `${command}${extension}`;
      if (existsSync(candidate))
        return candidate;
    }
  }
  return command;
}
function createSpawnCommand(command, platform = process.platform, commandProcessor = process.env["ComSpec"] ?? "cmd.exe", env = process.env) {
  const [cmd, ...args] = command;
  if (!cmd) {
    throw new LspProcessSpawnError("[lsp] empty command");
  }
  if (platform !== "win32") {
    return { command: cmd, args, shell: false };
  }
  const resolvedCommand = resolveWindowsCommand(cmd, env);
  if (!isWindowsShellShim(resolvedCommand)) {
    return { command: resolvedCommand, args, shell: false };
  }
  return {
    command: commandProcessor,
    args: ["/d", "/s", "/c", resolvedCommand, ...args],
    shell: false
  };
}
function spawnProcess(command, options) {
  const cwdValidation = validateCwd(options.cwd);
  if (!cwdValidation.valid) {
    throw new LspInvalidPathError(`[lsp] ${cwdValidation.error}`);
  }
  const [cmd] = command;
  if (!cmd) {
    throw new LspProcessSpawnError("[lsp] empty command");
  }
  const preparedCommand = createSpawnCommand(command, process.platform, process.env["ComSpec"] ?? "cmd.exe", options.env);
  const proc = childProcess.spawn(preparedCommand.command, preparedCommand.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: preparedCommand.shell,
    detached: process.platform !== "win32"
  });
  return wrap(proc);
}

// packages/lsp-tools-mcp/dist/lsp/server-installation.js
import { existsSync as existsSync2 } from "node:fs";
import { delimiter as delimiter2, join as join3 } from "node:path";
function getAdditionalPathBases(workingDirectory) {
  return [join3(workingDirectory, "node_modules", ".bin")];
}
function isServerInstalled(command) {
  if (command.length === 0)
    return false;
  const [cmd] = command;
  if (!cmd)
    return false;
  if (cmd.includes("/") || cmd.includes("\\")) {
    if (existsSync2(cmd))
      return true;
  }
  const isWindows = process.platform === "win32";
  let exts = [""];
  if (isWindows) {
    const pathExt = process.env["PATHEXT"] ?? "";
    if (pathExt) {
      const systemExts = pathExt.split(";").filter(Boolean);
      exts = [.../* @__PURE__ */ new Set([...exts, ...systemExts, ".exe", ".cmd", ".bat", ".ps1"])];
    } else {
      exts = ["", ".exe", ".cmd", ".bat", ".ps1"];
    }
  }
  let pathEnv = process.env["PATH"] ?? "";
  if (isWindows && !pathEnv) {
    pathEnv = process.env["Path"] ?? "";
  }
  const paths = pathEnv.split(delimiter2);
  for (const p of paths) {
    for (const suffix of exts) {
      if (existsSync2(join3(p, cmd + suffix))) {
        return true;
      }
    }
  }
  for (const base of getAdditionalPathBases(process.cwd())) {
    for (const suffix of exts) {
      if (existsSync2(join3(base, cmd + suffix))) {
        return true;
      }
    }
  }
  if (cmd === "node")
    return true;
  return false;
}

// packages/lsp-tools-mcp/dist/lsp/transport.js
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseConfigurationItems(params) {
  if (!isRecord(params) || !Array.isArray(params["items"]))
    return [];
  const items2 = [];
  for (const item of params["items"]) {
    if (!isRecord(item))
      continue;
    const section = item["section"];
    items2.push(section === void 0 || typeof section !== "string" ? {} : { section });
  }
  return items2;
}
function parseDiagnosticsParams(params) {
  if (!isRecord(params) || typeof params["uri"] !== "string")
    return null;
  const diagnostics = Array.isArray(params["diagnostics"]) ? params["diagnostics"].filter(isDiagnostic) : [];
  return { uri: params["uri"], diagnostics };
}
var LspClientTransport = class {
  constructor(root, server) {
    this.root = root;
    this.server = server;
    this.proc = null;
    this.connection = null;
    this.stderrBuffer = [];
    this.processExited = false;
    this.diagnosticsStore = /* @__PURE__ */ new Map();
  }
  pid() {
    return this.proc?.pid;
  }
  command() {
    return [...this.server.command];
  }
  async start() {
    const env = {
      ...process.env,
      ...this.server.env
    };
    const pathValue = process.platform === "win32" ? env["PATH"] ?? env["Path"] ?? "" : env["PATH"] ?? "";
    const spawnPath = [pathValue, ...getAdditionalPathBases(this.root)].filter(Boolean).join(delimiter3);
    if (process.platform === "win32" && env["Path"] !== void 0) {
      env["Path"] = spawnPath;
    }
    env["PATH"] = spawnPath;
    this.proc = spawnProcess(this.server.command, {
      cwd: this.root,
      env
    });
    this.startStderrReading();
    await new Promise((resolve6) => setTimeout(resolve6, 100));
    if (this.proc.exitCode !== null) {
      const stderr = this.stderrBuffer.join("\n");
      throw new LspProcessExitedError(this.server.id, this.root, this.proc.exitCode, stderr.slice(-2e3));
    }
    this.connection = new JsonRpcConnection(this.proc.stdout, this.proc.stdin);
    this.connection.onNotification("textDocument/publishDiagnostics", (params) => {
      const diagnosticsParams = parseDiagnosticsParams(params);
      if (diagnosticsParams?.uri) {
        this.diagnosticsStore.set(diagnosticsParams.uri, diagnosticsParams.diagnostics);
      }
    });
    this.connection.onRequest("workspace/configuration", (params) => {
      const items2 = parseConfigurationItems(params);
      return items2.map((item) => {
        if (item.section === "json")
          return { validate: { enable: true } };
        return {};
      });
    });
    this.connection.onRequest("client/registerCapability", () => null);
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onClose(() => {
      this.processExited = true;
    });
    this.connection.onError((error) => {
      reportBestEffortCleanupError("connection error notification", error);
    });
    this.connection.listen();
  }
  startStderrReading() {
    if (!this.proc)
      return;
    this.proc.stderr.setEncoding("utf-8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderrBuffer.push(chunk);
      if (this.stderrBuffer.length > 100) {
        this.stderrBuffer.shift();
      }
    });
  }
  isConnectionClosedError(error) {
    if (!(error instanceof Error)) {
      return false;
    }
    const code = "code" in error && typeof error.code === "string" ? error.code : void 0;
    return code === "ERR_STREAM_DESTROYED" || /connection closed|connection is disposed|stream was destroyed/i.test(error.message);
  }
  async sendRequest(method, ...args) {
    if (!this.connection)
      throw new Error("LSP client not started");
    if (this.processExited || this.proc && this.proc.exitCode !== null) {
      const stderrTail = this.stderrBuffer.slice(-10).join("\n");
      throw new LspProcessExitedError(this.server.id, this.root, this.proc?.exitCode ?? null, stderrTail || void 0);
    }
    let timeoutHandle = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const stderrTail = this.stderrBuffer.slice(-5).join("\n");
        reject(new LspRequestTimeoutError(method, stderrTail || void 0));
      }, REQUEST_TIMEOUT_MS);
    });
    try {
      const requestPromise = args.length === 0 ? this.connection.sendRequest(method) : this.connection.sendRequest(method, args[0]);
      const result = await Promise.race([requestPromise, timeoutPromise]);
      if (timeoutHandle !== null)
        clearTimeout(timeoutHandle);
      return result;
    } catch (error) {
      if (timeoutHandle !== null)
        clearTimeout(timeoutHandle);
      if (this.processExited || this.proc && this.proc.exitCode !== null) {
        throw new LspProcessExitedError(this.server.id, this.root, this.proc?.exitCode ?? null, this.stderrBuffer.slice(-10).join("\n") || void 0);
      }
      if (this.isConnectionClosedError(error)) {
        throw new LspConnectionClosedError(this.server.id, this.root, error.message);
      }
      throw error;
    }
  }
  async sendNotification(method, ...args) {
    if (!this.connection)
      return;
    if (this.processExited || this.proc && this.proc.exitCode !== null)
      return;
    try {
      if (args.length === 0) {
        await this.connection.sendNotification(method);
      } else {
        await this.connection.sendNotification(method, args[0]);
      }
    } catch (error) {
      if (this.isConnectionClosedError(error)) {
        throw new LspConnectionClosedError(this.server.id, this.root, error.message);
      }
      throw error;
    }
  }
  isAlive() {
    return this.proc !== null && !this.processExited && this.proc.exitCode === null;
  }
  async stop() {
    if (this.connection) {
      try {
        await this.sendRequest("shutdown");
      } catch (error) {
        reportBestEffortCleanupError("shutdown request", error);
      }
      try {
        await this.sendNotification("exit");
      } catch (error) {
        reportBestEffortCleanupError("exit notification", error);
      }
      try {
        this.connection.dispose();
      } catch (error) {
        reportBestEffortCleanupError("connection dispose", error);
      }
      this.connection = null;
    }
    const proc = this.proc;
    if (proc) {
      this.proc = null;
      let exitedBeforeTimeout = false;
      try {
        proc.kill();
        let timeoutId;
        const timeoutPromise = new Promise((resolve6) => {
          timeoutId = setTimeout(resolve6, STOP_HARD_KILL_TIMEOUT_MS);
        });
        await Promise.race([
          proc.exited.then(() => {
            exitedBeforeTimeout = true;
          }).finally(() => {
            if (timeoutId)
              clearTimeout(timeoutId);
          }),
          timeoutPromise
        ]);
        if (!exitedBeforeTimeout) {
          try {
            proc.kill("SIGKILL");
            await Promise.race([
              proc.exited,
              new Promise((resolve6) => setTimeout(resolve6, STOP_SIGKILL_GRACE_MS))
            ]);
          } catch (error) {
            reportBestEffortCleanupError("hard process kill", error);
          }
        }
      } catch (error) {
        reportBestEffortCleanupError("process stop", error);
      }
    }
    this.processExited = true;
    this.diagnosticsStore.clear();
  }
  getStoredDiagnostics(uri) {
    return this.diagnosticsStore.get(uri) ?? [];
  }
};
function isDiagnostic(value) {
  return isRecord(value) && isRange(value["range"]) && typeof value["message"] === "string";
}
function isRange(value) {
  return isRecord(value) && isPosition(value["start"]) && isPosition(value["end"]);
}
function isPosition(value) {
  return isRecord(value) && typeof value["line"] === "number" && typeof value["character"] === "number";
}

// packages/lsp-tools-mcp/dist/lsp/connection.js
var INITIALIZE_SETTLE_MS = 300;
var LspClientConnection = class extends LspClientTransport {
  async initialize() {
    const rootUri = pathToFileURL(this.root).href;
    await this.sendRequest("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: {},
          rename: {
            prepareSupport: true,
            prepareSupportDefaultBehavior: 1,
            honorsChangeAnnotations: true
          },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: [
                  "quickfix",
                  "refactor",
                  "refactor.extract",
                  "refactor.inline",
                  "refactor.rewrite",
                  "source",
                  "source.organizeImports",
                  "source.fixAll"
                ]
              }
            },
            isPreferredSupport: true,
            disabledSupport: true,
            dataSupport: true,
            resolveSupport: {
              properties: ["edit", "command"]
            }
          }
        },
        workspace: {
          symbol: {},
          workspaceFolders: true,
          configuration: true,
          applyEdit: true,
          workspaceEdit: {
            documentChanges: true
          }
        }
      },
      initializationOptions: this.server.initialization
    });
    await this.sendNotification("initialized");
    await this.sendNotification("workspace/didChangeConfiguration", {
      settings: { json: { validate: { enable: true } } }
    });
    await new Promise((r) => setTimeout(r, INITIALIZE_SETTLE_MS));
  }
};

// packages/lsp-tools-mcp/dist/lsp/language-mappings.js
var EXT_TO_LANG = {
  ".abap": "abap",
  ".bat": "bat",
  ".bib": "bibtex",
  ".bibtex": "bibtex",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",
  ".edn": "clojure",
  ".coffee": "coffeescript",
  ".c": "c",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".cc": "cpp",
  ".c++": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".d": "d",
  ".pas": "pascal",
  ".pascal": "pascal",
  ".diff": "diff",
  ".patch": "diff",
  ".dart": "dart",
  ".dockerfile": "dockerfile",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hrl": "erlang",
  ".fs": "fsharp",
  ".fsi": "fsharp",
  ".fsx": "fsharp",
  ".fsscript": "fsharp",
  ".gitcommit": "git-commit",
  ".gitrebase": "git-rebase",
  ".go": "go",
  ".groovy": "groovy",
  ".gleam": "gleam",
  ".hbs": "handlebars",
  ".handlebars": "handlebars",
  ".hs": "haskell",
  ".html": "html",
  ".htm": "html",
  ".ini": "ini",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".json": "json",
  ".jsonc": "jsonc",
  ".tex": "latex",
  ".latex": "latex",
  ".less": "less",
  ".lua": "lua",
  ".makefile": "makefile",
  makefile: "makefile",
  ".md": "markdown",
  ".markdown": "markdown",
  ".m": "objective-c",
  ".mm": "objective-cpp",
  ".pl": "perl",
  ".pm": "perl",
  ".pm6": "perl6",
  ".php": "php",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".pug": "jade",
  ".jade": "jade",
  ".py": "python",
  ".pyi": "python",
  ".r": "r",
  ".cshtml": "razor",
  ".razor": "razor",
  ".rb": "ruby",
  ".rake": "ruby",
  ".gemspec": "ruby",
  ".ru": "ruby",
  ".erb": "erb",
  ".html.erb": "erb",
  ".js.erb": "erb",
  ".css.erb": "erb",
  ".json.erb": "erb",
  ".rs": "rust",
  ".scss": "scss",
  ".sass": "sass",
  ".scala": "scala",
  ".shader": "shaderlab",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".ksh": "shellscript",
  ".sql": "sql",
  ".svelte": "svelte",
  ".swift": "swift",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".mtsx": "typescriptreact",
  ".ctsx": "typescriptreact",
  ".xml": "xml",
  ".xsl": "xsl",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".vue": "vue",
  ".zig": "zig",
  ".zon": "zig",
  ".astro": "astro",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".tf": "terraform",
  ".tfvars": "terraform-vars",
  ".hcl": "hcl",
  ".nix": "nix",
  ".typ": "typst",
  ".typc": "typst",
  ".ets": "typescript",
  ".lhs": "haskell",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".prisma": "prisma",
  ".h": "c",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".h++": "cpp",
  ".objc": "objective-c",
  ".objcpp": "objective-cpp",
  ".fish": "fish",
  ".graphql": "graphql",
  ".gql": "graphql"
};
function getLanguageId(ext) {
  return EXT_TO_LANG[ext] ?? "plaintext";
}

// packages/lsp-tools-mcp/dist/lsp/client.js
var POST_OPEN_DELAY_MS = 1e3;
var POST_DIAGNOSTICS_WAIT_MS = 500;
var LspClient = class extends LspClientConnection {
  constructor() {
    super(...arguments);
    this.openedFiles = /* @__PURE__ */ new Set();
    this.documentVersions = /* @__PURE__ */ new Map();
    this.lastSyncedText = /* @__PURE__ */ new Map();
    this.diagnosticPullErrors = [];
  }
  getDiagnosticPullErrors() {
    return this.diagnosticPullErrors;
  }
  async openFile(filePath) {
    const absPath = resolve2(filePath);
    const uri = pathToFileURL2(absPath).href;
    const text2 = readFileSync(absPath, "utf-8");
    if (!this.openedFiles.has(absPath)) {
      const ext = extname(absPath);
      const languageId = getLanguageId(ext);
      const version = 1;
      await this.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId,
          version,
          text: text2
        }
      });
      this.openedFiles.add(absPath);
      this.documentVersions.set(uri, version);
      this.lastSyncedText.set(uri, text2);
      await new Promise((r) => setTimeout(r, POST_OPEN_DELAY_MS));
      return;
    }
    const prevText = this.lastSyncedText.get(uri);
    if (prevText === text2) {
      return;
    }
    const nextVersion = (this.documentVersions.get(uri) ?? 1) + 1;
    this.documentVersions.set(uri, nextVersion);
    this.lastSyncedText.set(uri, text2);
    await this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text: text2 }]
    });
    await this.sendNotification("textDocument/didSave", {
      textDocument: { uri },
      text: text2
    });
  }
  async definition(filePath, line, character) {
    const absPath = resolve2(filePath);
    await this.openFile(absPath);
    return this.sendRequest("textDocument/definition", {
      textDocument: { uri: pathToFileURL2(absPath).href },
      position: { line: line - 1, character }
    });
  }
  async references(filePath, line, character, includeDeclaration = true) {
    const absPath = resolve2(filePath);
    await this.openFile(absPath);
    return this.sendRequest("textDocument/references", {
      textDocument: { uri: pathToFileURL2(absPath).href },
      position: { line: line - 1, character },
      context: { includeDeclaration }
    });
  }
  async documentSymbols(filePath) {
    const absPath = resolve2(filePath);
    await this.openFile(absPath);
    return this.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri: pathToFileURL2(absPath).href }
    });
  }
  async workspaceSymbols(query) {
    return this.sendRequest("workspace/symbol", { query });
  }
  isUnsupportedDiagnosticPullError(error) {
    if (!(error instanceof Error))
      return false;
    const code = "code" in error && typeof error.code === "number" ? error.code : void 0;
    if (code === -32601)
      return true;
    return /unsupported|not supported|method not found|unknown request/i.test(error.message);
  }
  async diagnostics(filePath) {
    const absPath = resolve2(filePath);
    const uri = pathToFileURL2(absPath).href;
    await this.openFile(absPath);
    await new Promise((r) => setTimeout(r, POST_DIAGNOSTICS_WAIT_MS));
    try {
      const result = await this.sendRequest("textDocument/diagnostic", {
        textDocument: { uri }
      });
      if (result.items) {
        return { items: result.items };
      }
    } catch (error) {
      if (!this.isUnsupportedDiagnosticPullError(error)) {
        this.diagnosticPullErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return { items: this.getStoredDiagnostics(uri) };
  }
  async prepareRename(filePath, line, character) {
    const absPath = resolve2(filePath);
    await this.openFile(absPath);
    return this.sendRequest("textDocument/prepareRename", {
      textDocument: { uri: pathToFileURL2(absPath).href },
      position: { line: line - 1, character }
    });
  }
  async rename(filePath, line, character, newName) {
    const absPath = resolve2(filePath);
    await this.openFile(absPath);
    return this.sendRequest("textDocument/rename", {
      textDocument: { uri: pathToFileURL2(absPath).href },
      position: { line: line - 1, character },
      newName
    });
  }
};

// packages/lsp-tools-mcp/dist/lsp/client-wrapper.js
import { statSync as statSync4 } from "node:fs";
import { extname as extname2, resolve as resolve4 } from "node:path";

// packages/lsp-tools-mcp/dist/lsp/process-signal-cleanup.js
import { constants } from "node:os";
var PROCESS_SIGNALS = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
var registrations = /* @__PURE__ */ new Set();
var signalHandlers = /* @__PURE__ */ new Map();
var handlersInstalled = false;
var handlingSignal = false;
function removeSignalHandlers() {
  if (!handlersInstalled)
    return;
  for (const [signal, handler] of signalHandlers)
    process.removeListener(signal, handler);
  signalHandlers.clear();
  handlersInstalled = false;
}
function signalExitCode(signal) {
  return 128 + (constants.signals[signal] ?? 1);
}
function terminateParent(signal) {
  if (process.platform === "win32" && signal === "SIGBREAK") {
    process.exit(signalExitCode(signal));
  }
  try {
    process.kill(process.pid, signal);
  } catch (error) {
    reportBestEffortCleanupError("signal re-delivery", error);
    process.exit(signalExitCode(signal));
  }
}
async function runCleanup(registration) {
  try {
    await registration.cleanup();
  } catch (error) {
    reportBestEffortCleanupError("signal cleanup", error);
  }
}
function handleSignal(signal) {
  if (handlingSignal)
    return;
  handlingSignal = true;
  const activeRegistrations = [...registrations];
  const shouldTerminateParent = activeRegistrations.some((registration) => registration.terminatesParent);
  void Promise.all(activeRegistrations.map(runCleanup)).then(() => {
    removeSignalHandlers();
    if (shouldTerminateParent) {
      terminateParent(signal);
      return;
    }
    handlingSignal = false;
    if (registrations.size > 0)
      ensureSignalHandlers();
  });
}
function ensureSignalHandlers() {
  if (handlersInstalled)
    return;
  for (const signal of PROCESS_SIGNALS) {
    const handler = () => handleSignal(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  handlersInstalled = true;
}
function installProcessSignalCleanup(cleanup, options = {}) {
  const registration = {
    cleanup,
    terminatesParent: options.terminateParent ?? false
  };
  registrations.add(registration);
  ensureSignalHandlers();
  return () => {
    registrations.delete(registration);
    if (registrations.size === 0 && !handlingSignal)
      removeSignalHandlers();
  };
}

// packages/lsp-tools-mcp/dist/lsp/manager.js
async function stopClientBestEffort(client) {
  try {
    await client.stop();
  } catch (error) {
    reportBestEffortCleanupError("client stop", error);
  }
}
function awaitWithSignal(promise, signal) {
  if (!signal)
    return promise;
  return new Promise((resolve6, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled)
        return;
      settled = true;
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      if (settled)
        return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve6(value);
    }, (err) => {
      if (settled)
        return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}
var LspManager = class {
  constructor(options = {}) {
    this.clients = /* @__PURE__ */ new Map();
    this.reaperHandle = null;
    this.signalDisposer = null;
    this.disposed = false;
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.reaperIntervalMs = options.reaperIntervalMs ?? REAPER_INTERVAL_MS;
    this.clientFactory = options.clientFactory ?? ((root, server) => new LspClient(root, server));
    this.now = options.now ?? (() => Date.now());
    this.startReaper();
    this.signalDisposer = installProcessSignalCleanup(() => this.stopAll());
  }
  startReaper() {
    if (this.reaperHandle)
      return;
    this.reaperHandle = setInterval(() => {
      this.reapStale();
    }, this.reaperIntervalMs);
    if (typeof this.reaperHandle.unref === "function") {
      this.reaperHandle.unref();
    }
  }
  getKey(root, serverId) {
    return `${root}::${serverId}`;
  }
  reapStale() {
    const t = this.now();
    for (const [key, managed] of this.clients) {
      if (managed.isInitializing && managed.initializingSince !== null && t - managed.initializingSince > this.initTimeoutMs) {
        void stopClientBestEffort(managed.client);
        this.clients.delete(key);
        continue;
      }
      if (!managed.isInitializing && managed.refCount === 0 && managed.pendingWaiters === 0 && t - managed.lastUsedAt > this.idleTimeoutMs) {
        void stopClientBestEffort(managed.client);
        this.clients.delete(key);
      }
    }
  }
  async tryDeleteIfOrphaned(key, managed) {
    if (managed.refCount === 0 && managed.pendingWaiters === 0 && !managed.isInitializing && this.clients.get(key) === managed) {
      this.clients.delete(key);
      await stopClientBestEffort(managed.client);
    }
  }
  async getClient(root, server, signal) {
    if (this.disposed) {
      throw new Error("LspManager has been disposed");
    }
    signal?.throwIfAborted();
    const key = this.getKey(root, server.id);
    let managed = this.clients.get(key);
    if (managed) {
      const t = this.now();
      if (managed.isInitializing && managed.initializingSince !== null && t - managed.initializingSince > this.initTimeoutMs) {
        await stopClientBestEffort(managed.client);
        this.clients.delete(key);
        managed = void 0;
      }
    }
    if (managed) {
      if (managed.initPromise) {
        managed.pendingWaiters++;
        try {
          await awaitWithSignal(managed.initPromise, signal);
        } catch (err) {
          managed.pendingWaiters--;
          await this.tryDeleteIfOrphaned(key, managed);
          throw err;
        }
        managed.pendingWaiters--;
      }
      if (signal?.aborted) {
        await this.tryDeleteIfOrphaned(key, managed);
        signal.throwIfAborted();
      }
      if (!managed.client.isAlive()) {
        await stopClientBestEffort(managed.client);
        this.clients.delete(key);
        return this.getClient(root, server, signal);
      }
      managed.refCount++;
      managed.lastUsedAt = this.now();
      return managed.client;
    }
    const client = this.clientFactory(root, server);
    const initStartedAt = this.now();
    const initPromise = (async () => {
      await client.start();
      await client.initialize();
    })();
    const newManaged = {
      client,
      refCount: 0,
      pendingWaiters: 1,
      lastUsedAt: initStartedAt,
      initPromise,
      isInitializing: true,
      initializingSince: initStartedAt
    };
    this.clients.set(key, newManaged);
    try {
      await awaitWithSignal(initPromise, signal);
    } catch (err) {
      newManaged.pendingWaiters--;
      if (this.clients.get(key) === newManaged) {
        this.clients.delete(key);
      }
      await stopClientBestEffort(client);
      throw err;
    }
    newManaged.pendingWaiters--;
    newManaged.isInitializing = false;
    newManaged.initializingSince = null;
    newManaged.initPromise = null;
    if (signal?.aborted) {
      await this.tryDeleteIfOrphaned(key, newManaged);
      signal.throwIfAborted();
    }
    newManaged.refCount++;
    newManaged.lastUsedAt = this.now();
    return client;
  }
  releaseClient(root, serverId) {
    const key = this.getKey(root, serverId);
    const managed = this.clients.get(key);
    if (managed && managed.refCount > 0) {
      managed.refCount--;
      managed.lastUsedAt = this.now();
    }
  }
  invalidateClient(root, serverId, client) {
    const key = this.getKey(root, serverId);
    const managed = this.clients.get(key);
    if (!managed)
      return;
    if (client && managed.client !== client)
      return;
    this.clients.delete(key);
    void stopClientBestEffort(managed.client);
  }
  warmupClient(root, server) {
    if (this.disposed)
      return;
    const key = this.getKey(root, server.id);
    if (this.clients.has(key))
      return;
    const client = this.clientFactory(root, server);
    const initStartedAt = this.now();
    const initPromise = (async () => {
      await client.start();
      await client.initialize();
    })();
    const managed = {
      client,
      refCount: 0,
      pendingWaiters: 0,
      lastUsedAt: initStartedAt,
      initPromise,
      isInitializing: true,
      initializingSince: initStartedAt
    };
    this.clients.set(key, managed);
    initPromise.then(() => {
      managed.isInitializing = false;
      managed.initializingSince = null;
      managed.initPromise = null;
      managed.lastUsedAt = this.now();
    }, () => {
      if (this.clients.get(key) === managed) {
        this.clients.delete(key);
      }
      void stopClientBestEffort(client);
    });
  }
  isServerInitializing(root, serverId) {
    const managed = this.clients.get(this.getKey(root, serverId));
    return managed?.isInitializing ?? false;
  }
  getSnapshot() {
    const snapshots = [];
    for (const [key, managed] of this.clients) {
      const [root, serverId] = key.split("::");
      snapshots.push({
        root,
        serverId,
        refCount: managed.refCount,
        pendingWaiters: managed.pendingWaiters,
        lastUsedAt: managed.lastUsedAt,
        isInitializing: managed.isInitializing,
        alive: managed.client.isAlive(),
        command: managed.client.command()
      });
    }
    return snapshots;
  }
  hasClient(root, serverId) {
    return this.clients.has(this.getKey(root, serverId));
  }
  clientCount() {
    return this.clients.size;
  }
  async stopAll() {
    this.disposed = true;
    if (this.reaperHandle) {
      clearInterval(this.reaperHandle);
      this.reaperHandle = null;
    }
    if (this.signalDisposer) {
      this.signalDisposer();
      this.signalDisposer = null;
    }
    const stopPromises = [];
    for (const managed of this.clients.values()) {
      stopPromises.push(stopClientBestEffort(managed.client));
    }
    this.clients.clear();
    await Promise.allSettled(stopPromises);
  }
};
var _defaultInstance = null;
function getLspManager() {
  if (!_defaultInstance) {
    _defaultInstance = new LspManager();
  }
  return _defaultInstance;
}

// packages/lsp-tools-mcp/dist/lsp/config-loader.js
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute as isAbsolute2, join as join4 } from "node:path";

// packages/lsp-tools-mcp/dist/lsp/server-definitions.js
var LSP_INSTALL_HINTS = {
  typescript: "npm install -g typescript-language-server typescript",
  deno: "Install Deno from https://deno.land",
  vue: "npm install -g @vue/language-server",
  eslint: "npm install -g vscode-langservers-extracted",
  oxlint: "npm install -g oxlint",
  biome: "npm install -g @biomejs/biome",
  gopls: "go install golang.org/x/tools/gopls@latest",
  "ruby-lsp": "gem install ruby-lsp",
  basedpyright: "pip install basedpyright",
  pyright: "pip install pyright",
  ty: "pip install ty",
  ruff: "pip install ruff",
  "elixir-ls": "See https://github.com/elixir-lsp/elixir-ls",
  zls: "See https://github.com/zigtools/zls",
  csharp: "dotnet tool install -g csharp-ls",
  fsharp: "dotnet tool install -g fsautocomplete",
  "sourcekit-lsp": "Included with Xcode or Swift toolchain",
  rust: "Install rust-analyzer and ensure it is in PATH. If using rustup: rustup component add rust-analyzer. If rust-analyzer exits while loading rust-src: rustup component remove rust-src && rustup component add rust-src.",
  clangd: "See https://clangd.llvm.org/installation",
  svelte: "npm install -g svelte-language-server",
  astro: "npm install -g @astrojs/language-server",
  "bash-ls": "npm install -g bash-language-server",
  jdtls: "See https://github.com/eclipse-jdtls/eclipse.jdt.ls",
  "yaml-ls": "npm install -g yaml-language-server",
  "lua-ls": "See https://github.com/LuaLS/lua-language-server",
  php: "npm install -g intelephense",
  dart: "Included with Dart SDK",
  "terraform-ls": "See https://github.com/hashicorp/terraform-ls",
  terraform: "See https://github.com/hashicorp/terraform-ls",
  prisma: "npm install -g prisma",
  "ocaml-lsp": "opam install ocaml-lsp-server",
  texlab: "See https://github.com/latex-lsp/texlab",
  dockerfile: "npm install -g dockerfile-language-server-nodejs",
  gleam: "See https://gleam.run/getting-started/installing/",
  "clojure-lsp": "See https://clojure-lsp.io/installation/",
  nixd: "nix profile install nixpkgs#nixd",
  tinymist: "See https://github.com/Myriad-Dreamin/tinymist",
  "haskell-language-server": "ghcup install hls",
  bash: "npm install -g bash-language-server",
  "kotlin-ls": "See https://github.com/Kotlin/kotlin-lsp"
};
var BUILTIN_SERVERS = {
  typescript: {
    command: ["typescript-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]
  },
  deno: { command: ["deno", "lsp"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"] },
  vue: { command: ["vue-language-server", "--stdio"], extensions: [".vue"] },
  eslint: {
    command: ["vscode-eslint-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue"]
  },
  oxlint: {
    command: ["oxlint", "--lsp"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".astro", ".svelte"]
  },
  biome: {
    command: ["biome", "lsp-proxy", "--stdio"],
    extensions: [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".mts",
      ".cts",
      ".json",
      ".jsonc",
      ".vue",
      ".astro",
      ".svelte",
      ".css",
      ".graphql",
      ".gql",
      ".html"
    ]
  },
  gopls: { command: ["gopls"], extensions: [".go"] },
  "ruby-lsp": {
    command: ["rubocop", "--lsp"],
    extensions: [".rb", ".rake", ".gemspec", ".ru"]
  },
  basedpyright: {
    command: ["basedpyright-langserver", "--stdio"],
    extensions: [".py", ".pyi"]
  },
  pyright: { command: ["pyright-langserver", "--stdio"], extensions: [".py", ".pyi"] },
  ty: { command: ["ty", "server"], extensions: [".py", ".pyi"] },
  ruff: { command: ["ruff", "server"], extensions: [".py", ".pyi"] },
  "elixir-ls": { command: ["elixir-ls"], extensions: [".ex", ".exs"] },
  zls: { command: ["zls"], extensions: [".zig", ".zon"] },
  csharp: { command: ["csharp-ls"], extensions: [".cs"] },
  fsharp: { command: ["fsautocomplete"], extensions: [".fs", ".fsi", ".fsx", ".fsscript"] },
  "sourcekit-lsp": { command: ["sourcekit-lsp"], extensions: [".swift", ".objc", ".objcpp"] },
  rust: { command: ["rust-analyzer"], extensions: [".rs"] },
  clangd: {
    command: ["clangd", "--background-index", "--clang-tidy"],
    extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"]
  },
  svelte: { command: ["svelteserver", "--stdio"], extensions: [".svelte"] },
  astro: { command: ["astro-ls", "--stdio"], extensions: [".astro"] },
  bash: {
    command: ["bash-language-server", "start"],
    extensions: [".sh", ".bash", ".zsh", ".ksh"]
  },
  "bash-ls": {
    command: ["bash-language-server", "start"],
    extensions: [".sh", ".bash", ".zsh", ".ksh"]
  },
  jdtls: { command: ["jdtls"], extensions: [".java"] },
  "yaml-ls": { command: ["yaml-language-server", "--stdio"], extensions: [".yaml", ".yml"] },
  "lua-ls": { command: ["lua-language-server"], extensions: [".lua"] },
  php: { command: ["intelephense", "--stdio"], extensions: [".php"] },
  dart: { command: ["dart", "language-server", "--lsp"], extensions: [".dart"] },
  terraform: { command: ["terraform-ls", "serve"], extensions: [".tf", ".tfvars"] },
  "terraform-ls": { command: ["terraform-ls", "serve"], extensions: [".tf", ".tfvars"] },
  prisma: { command: ["prisma", "language-server"], extensions: [".prisma"] },
  "ocaml-lsp": { command: ["ocamllsp"], extensions: [".ml", ".mli"] },
  texlab: { command: ["texlab"], extensions: [".tex", ".bib"] },
  dockerfile: { command: ["docker-langserver", "--stdio"], extensions: [".dockerfile"] },
  gleam: { command: ["gleam", "lsp"], extensions: [".gleam"] },
  "clojure-lsp": {
    command: ["clojure-lsp", "listen"],
    extensions: [".clj", ".cljs", ".cljc", ".edn"]
  },
  nixd: { command: ["nixd"], extensions: [".nix"] },
  tinymist: { command: ["tinymist"], extensions: [".typ", ".typc"] },
  "haskell-language-server": {
    command: ["haskell-language-server-wrapper", "--lsp"],
    extensions: [".hs", ".lhs"]
  },
  "kotlin-ls": { command: ["kotlin-lsp"], extensions: [".kt", ".kts"] }
};

// packages/lsp-tools-mcp/dist/lsp/config-loader.js
function getConfigPaths() {
  const cwd = process.cwd();
  const projectOverride = process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"];
  const userOverride = process.env["LSP_TOOLS_MCP_USER_CONFIG"];
  return {
    project: projectOverride ? isAbsolute2(projectOverride) ? projectOverride : join4(cwd, projectOverride) : join4(cwd, ".codex", "lsp-client.json"),
    user: userOverride ? isAbsolute2(userOverride) ? userOverride : join4(homedir(), userOverride) : join4(homedir(), ".codex", "lsp-client.json")
  };
}
function loadJsonFile(path) {
  if (!existsSync3(path))
    return null;
  try {
    const parsed = JSON.parse(readFileSync2(path, "utf-8"));
    return isConfigJson(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function loadAllConfigs() {
  const paths = getConfigPaths();
  const configs = /* @__PURE__ */ new Map();
  const project = loadJsonFile(paths.project);
  if (project)
    configs.set("project", project);
  const user = loadJsonFile(paths.user);
  if (user)
    configs.set("user", user);
  return configs;
}
function getMergedServers() {
  const configs = loadAllConfigs();
  const servers = [];
  const disabled = /* @__PURE__ */ new Set();
  const seen = /* @__PURE__ */ new Set();
  const sources = ["project", "user"];
  for (const source of sources) {
    const config = configs.get(source);
    if (!config?.lsp)
      continue;
    for (const [id, rawEntry] of Object.entries(config.lsp)) {
      const entry = parseLspEntry(rawEntry);
      if (!entry)
        continue;
      if (entry.disabled) {
        disabled.add(id);
        continue;
      }
      if (seen.has(id))
        continue;
      if (!entry.command || !entry.extensions)
        continue;
      const server = {
        id,
        command: entry.command,
        extensions: entry.extensions,
        priority: entry.priority ?? 0,
        source
      };
      if (entry.env !== void 0) {
        server.env = entry.env;
      }
      if (entry.initialization !== void 0) {
        server.initialization = entry.initialization;
      }
      servers.push(server);
      seen.add(id);
    }
  }
  for (const [id, config] of Object.entries(BUILTIN_SERVERS)) {
    if (disabled.has(id) || seen.has(id))
      continue;
    servers.push({
      id,
      command: config.command,
      extensions: config.extensions,
      priority: -100,
      source: "builtin"
    });
  }
  return servers.sort((a, b) => {
    if (a.source !== b.source) {
      const order = {
        project: 0,
        user: 1,
        builtin: 2
      };
      return order[a.source] - order[b.source];
    }
    return b.priority - a.priority;
  });
}
function isConfigJson(value) {
  if (!isRecord2(value))
    return false;
  const lsp = value["lsp"];
  return lsp === void 0 || isRecord2(lsp);
}
function parseLspEntry(value) {
  return isLspEntry(value) ? value : null;
}
function isLspEntry(value) {
  if (!isRecord2(value))
    return false;
  const disabled = value["disabled"];
  const command = value["command"];
  const extensions = value["extensions"];
  const priority = value["priority"];
  const env = value["env"];
  const initialization = value["initialization"];
  return (disabled === void 0 || typeof disabled === "boolean") && (command === void 0 || isStringArray(command)) && (extensions === void 0 || isStringArray(extensions)) && (priority === void 0 || typeof priority === "number") && (env === void 0 || isStringRecord(env)) && (initialization === void 0 || isRecord2(initialization));
}
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isStringRecord(value) {
  return isRecord2(value) && Object.values(value).every((item) => typeof item === "string");
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// packages/lsp-tools-mcp/dist/lsp/server-resolution.js
function findServerForExtension(ext) {
  const servers = getMergedServers();
  for (const server of servers) {
    if (server.extensions.includes(ext) && isServerInstalled(server.command)) {
      const resolvedServer = {
        id: server.id,
        command: server.command,
        extensions: server.extensions,
        priority: server.priority
      };
      if (server.env !== void 0) {
        return {
          status: "found",
          server: {
            ...resolvedServer,
            env: server.env,
            ...server.initialization === void 0 ? {} : { initialization: server.initialization }
          }
        };
      }
      return {
        status: "found",
        server: {
          ...resolvedServer,
          ...server.initialization === void 0 ? {} : { initialization: server.initialization }
        }
      };
    }
  }
  for (const server of servers) {
    if (server.extensions.includes(ext)) {
      const installHint = LSP_INSTALL_HINTS[server.id] ?? `Install '${server.command[0]}' and ensure it's in your PATH`;
      return {
        status: "not_installed",
        server: {
          id: server.id,
          command: server.command,
          extensions: server.extensions
        },
        installHint
      };
    }
  }
  const availableServers = [...new Set(servers.map((s) => s.id))];
  return {
    status: "not_configured",
    extension: ext,
    availableServers
  };
}

// packages/lsp-tools-mcp/dist/lsp/workspace-root.js
import { existsSync as existsSync5, statSync as statSync3 } from "node:fs";
import { dirname as dirname3, join as join8, resolve as resolve3 } from "node:path";

// packages/lsp-tools-mcp/dist/lsp/cargo-workspace-root.js
import { existsSync as existsSync4, realpathSync as realpathSync2 } from "node:fs";
import { dirname as dirname2, join as join7 } from "node:path";

// packages/lsp-tools-mcp/dist/lsp/abortable-shared-operation.js
function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}
function releaseSharedOperationWaiter(operation) {
  operation.waiterCount -= 1;
  if (operation.waiterCount > 0 || operation.settled)
    return;
  operation.controller.abort();
  operation.onAbandoned();
  void operation.promise.catch(() => void 0);
}
function createSharedAbortableOperation(run2, onSettled, onAbandoned) {
  const controller = new AbortController();
  let operation;
  const promise = run2(controller.signal).finally(() => {
    operation.settled = true;
    onSettled();
  });
  operation = {
    controller,
    promise,
    onAbandoned,
    waiterCount: 0,
    settled: false
  };
  void promise.catch(() => void 0);
  return operation;
}
function awaitSharedAbortableOperation(operation, signal) {
  signal?.throwIfAborted();
  operation.waiterCount += 1;
  return new Promise((resolve6, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled)
        return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      releaseSharedOperationWaiter(operation);
      reject(signal === void 0 ? new DOMException("Aborted", "AbortError") : abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    operation.promise.then((value) => {
      if (settled)
        return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      releaseSharedOperationWaiter(operation);
      resolve6(value);
    }, (error) => {
      if (settled)
        return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      releaseSharedOperationWaiter(operation);
      reject(error);
    });
  });
}

// packages/lsp-tools-mcp/dist/lsp/cargo-manifest-snapshot.js
import { readFileSync as readFileSync3 } from "node:fs";
import { dirname, join as join5 } from "node:path";
function isMissingManifestError(error) {
  if (!(error instanceof Error))
    return false;
  const code = "code" in error ? error.code : void 0;
  return code === "ENOENT" || code === "ENOTDIR";
}
function readManifestSnapshot(path, allowMissing = false) {
  try {
    return { path, exists: true, content: readFileSync3(path, "utf8") };
  } catch (error) {
    if (allowMissing && isMissingManifestError(error)) {
      return { path, exists: false, content: void 0 };
    }
    return void 0;
  }
}
function snapshotsAreFresh(snapshots) {
  for (const snapshot of snapshots) {
    const candidate = readManifestSnapshot(snapshot.path, true);
    if (candidate === void 0)
      return false;
    if (candidate.exists !== snapshot.exists)
      return false;
    if (!candidate.exists)
      continue;
    if (candidate.content !== snapshot.content)
      return false;
  }
  return true;
}
function ancestorManifestPaths(manifestDir) {
  const paths = [];
  const seen = /* @__PURE__ */ new Set();
  let dir = manifestDir;
  let prev = "";
  while (dir !== prev) {
    const manifestPath = join5(dir, "Cargo.toml");
    if (!seen.has(manifestPath)) {
      seen.add(manifestPath);
      paths.push(manifestPath);
    }
    prev = dir;
    dir = dirname(dir);
  }
  return paths;
}
function readAncestorManifestSnapshots(manifestDir) {
  const snapshots = [];
  const manifestPaths = ancestorManifestPaths(manifestDir);
  for (const [index, manifestPath] of manifestPaths.entries()) {
    const snapshot = readManifestSnapshot(manifestPath, true);
    if (snapshot === void 0)
      return void 0;
    if (index === 0 && !snapshot.exists)
      return void 0;
    snapshots.push(snapshot);
  }
  return snapshots.length === 0 ? void 0 : snapshots;
}

// packages/lsp-tools-mcp/dist/lsp/cargo-metadata-parser.js
import { readFileSync as readFileSync4, realpathSync, statSync as statSync2 } from "node:fs";
import { isAbsolute as isAbsolute3, join as join6, relative as relative2, sep as sep2 } from "node:path";

// node_modules/smol-toml/dist/date.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[T ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[-+]\d{2}:\d{2})?$/i;
var TomlDate = class _TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    if (typeof date === "string") {
      let match = date.match(DATE_TIME_RE);
      if (match) {
        if (!match[1]) {
          hasDate = false;
          date = `0000-01-01T${date}`;
        }
        hasTime = !!match[2];
        hasTime && date[10] === " " && (date = date.replace(" ", "T"));
        if (match[2] && +match[2] > 23) {
          date = "";
        } else {
          offset = match[3] || null;
          date = date.toUpperCase();
          if (!offset && hasTime)
            date += "Z";
        }
      } else {
        date = "";
      }
    }
    super(date);
    if (!isNaN(this.getTime())) {
      this.#hasDate = hasDate;
      this.#hasTime = hasTime;
      this.#offset = offset;
    }
  }
  isDateTime() {
    return this.#hasDate && this.#hasTime;
  }
  isLocal() {
    return !this.#hasDate || !this.#hasTime || !this.#offset;
  }
  isDate() {
    return this.#hasDate && !this.#hasTime;
  }
  isTime() {
    return this.#hasTime && !this.#hasDate;
  }
  isValid() {
    return this.#hasDate || this.#hasTime;
  }
  toISOString() {
    let iso = super.toISOString();
    if (this.isDate())
      return iso.slice(0, 10);
    if (this.isTime())
      return iso.slice(11, 23);
    if (this.#offset === null)
      return iso.slice(0, -1);
    if (this.#offset === "Z")
      return iso;
    let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
    offset = this.#offset[0] === "-" ? offset : -offset;
    let offsetDate = new Date(this.getTime() - offset * 6e4);
    return offsetDate.toISOString().slice(0, -1) + this.#offset;
  }
  static wrapAsOffsetDateTime(jsDate, offset = "Z") {
    let date = new _TomlDate(jsDate);
    date.#offset = offset;
    return date;
  }
  static wrapAsLocalDateTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#offset = null;
    return date;
  }
  static wrapAsLocalDate(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasTime = false;
    date.#offset = null;
    return date;
  }
  static wrapAsLocalTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasDate = false;
    date.#offset = null;
    return date;
  }
};

// node_modules/smol-toml/dist/error.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function getLineColFromPtr(string2, ptr) {
  let lines = string2.slice(0, ptr).split(/\r\n|\n|\r/g);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string2, line, column) {
  let lines = string2.split(/\r\n|\n|\r/g);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1; i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += "\n";
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += "^\n";
    }
  }
  return codeblock;
}
var TomlError = class extends Error {
  line;
  column;
  codeblock;
  constructor(message2, options) {
    const [line, column] = getLineColFromPtr(options.toml, options.ptr);
    const codeblock = makeCodeBlock(options.toml, line, column);
    super(`Invalid TOML document: ${message2}

${codeblock}`, options);
    this.line = line;
    this.column = column;
    this.codeblock = codeblock;
  }
};

// node_modules/smol-toml/dist/primitive.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var INT_REGEX = /^((0x[0-9a-fA-F](_?[0-9a-fA-F])*)|(([+-]|0[ob])?\d(_?\d)*))$/;
var FLOAT_REGEX = /^[+-]?\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/;
var LEADING_ZERO = /^[+-]?0[0-9_]/;
function parseString(str, ptr) {
  let c = str[ptr++];
  let first = c;
  let isLiteral = c === "'";
  let isMultiline = c === str[ptr] && c === str[ptr + 1];
  if (isMultiline) {
    if (str[ptr += 2] === "\n")
      ptr++;
    else if (str[ptr] === "\r" && str[ptr + 1] === "\n")
      ptr += 2;
  }
  let parsed = "";
  let sliceStart = ptr;
  let state = 0;
  for (let i = ptr; i < str.length; i++) {
    c = str[i];
    if (isMultiline && (c === "\n" || c === "\r" && str[i + 1] === "\n")) {
      state = state && 3;
    } else if (c < " " && c !== "	" || c === "\x7F") {
      throw new TomlError("control characters are not allowed in strings", {
        toml: str,
        ptr: i
      });
    } else if ((!state || state === 3) && c === first && (!isMultiline || str[i + 1] === first && str[i + 2] === first)) {
      if (isMultiline) {
        if (str[i + 3] === first)
          i++;
        if (str[i + 3] === first)
          i++;
      }
      return [
        // If we're in a newline escape still, then there's nothing to add.
        // Also try to avoid concat if there's nothing to add to parsed, or nothing has been added to parsed.
        state ? parsed : parsed + str.slice(sliceStart, i),
        i + (isMultiline ? 3 : 1)
      ];
    } else if (!state) {
      if (!isLiteral && c === "\\") {
        parsed += str.slice(sliceStart, sliceStart = i);
        state = 1;
      }
    } else if (state === 1) {
      if (c === "x" || c === "u" || c === "U") {
        let value = 0;
        let len = c === "x" ? 2 : c === "u" ? 4 : 8;
        for (let j = 0; j < len; j++, i++) {
          let hex = str.charCodeAt(i + 1);
          let digit = (
            /* 0-9 */
            hex >= 48 && hex <= 57 ? hex - 48 : (
              /* A-F */
              hex >= 65 && hex <= 70 ? hex - 65 + 10 : (
                /* a-f */
                hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1
              )
            )
          );
          if (digit < 0)
            throw new TomlError("invalid non-hex character in unicode escape", { toml: str, ptr: i + 1 });
          value = value << 4 | digit;
        }
        if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
          throw new TomlError("invalid unicode escape", { toml: str, ptr: i });
        }
        parsed += String.fromCodePoint(value);
        sliceStart = i + 1;
        state = 0;
      } else if (c === " " || c === "	") {
        state = 2;
      } else {
        if (c === "b")
          parsed += "\b";
        else if (c === "t")
          parsed += "	";
        else if (c === "n")
          parsed += "\n";
        else if (c === "f")
          parsed += "\f";
        else if (c === "r")
          parsed += "\r";
        else if (c === "e")
          parsed += "\x1B";
        else if (c === '"')
          parsed += '"';
        else if (c === "\\")
          parsed += "\\";
        else
          throw new TomlError("unrecognized escape sequence", { toml: str, ptr: i });
        sliceStart = i + 1;
        state = 0;
      }
    } else if (c !== " " && c !== "	") {
      if (state === 2) {
        throw new TomlError("invalid escape: only line-ending whitespace may be escaped", {
          toml: str,
          ptr: sliceStart
        });
      }
      state = !isLiteral && c === "\\" ? 1 : 0;
      sliceStart = i;
    }
  }
  throw new TomlError("unfinished string", { toml: str, ptr });
}
function parseValue(value, toml, ptr, integersAsBigInt) {
  if (value === "true")
    return true;
  if (value === "false")
    return false;
  if (value === "-inf")
    return -Infinity;
  if (value === "inf" || value === "+inf")
    return Infinity;
  if (value === "nan" || value === "+nan" || value === "-nan")
    return NaN;
  if (value === "-0")
    return integersAsBigInt ? 0n : 0;
  let isInt = INT_REGEX.test(value);
  if (isInt || FLOAT_REGEX.test(value)) {
    if (LEADING_ZERO.test(value)) {
      throw new TomlError("leading zeroes are not allowed", {
        toml,
        ptr
      });
    }
    value = value.replace(/_/g, "");
    let numeric = +value;
    if (isNaN(numeric)) {
      throw new TomlError("invalid number", {
        toml,
        ptr
      });
    }
    if (isInt) {
      if ((isInt = !Number.isSafeInteger(numeric)) && !integersAsBigInt) {
        throw new TomlError("integer value cannot be represented losslessly", {
          toml,
          ptr
        });
      }
      if (isInt || integersAsBigInt === true)
        numeric = BigInt(value);
    }
    return numeric;
  }
  const date = new TomlDate(value);
  if (!date.isValid()) {
    throw new TomlError("invalid value", {
      toml,
      ptr
    });
  }
  return date;
}

// node_modules/smol-toml/dist/util.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function indexOfNewline(str, start = 0, end = str.length) {
  let idx = str.indexOf("\n", start);
  if (str[idx - 1] === "\r")
    idx--;
  return idx <= end ? idx : -1;
}
function skipComment(str, ptr) {
  for (let i = ptr; i < str.length; i++) {
    let c = str[i];
    if (c === "\n")
      return i;
    if (c === "\r" && str[i + 1] === "\n")
      return i + 1;
    if (c < " " && c !== "	" || c === "\x7F") {
      throw new TomlError("control characters are not allowed in comments", {
        toml: str,
        ptr
      });
    }
  }
  return str.length;
}
function skipVoid(str, ptr, banNewLines, banComments) {
  let c;
  while (1) {
    while ((c = str[ptr]) === " " || c === "	" || !banNewLines && (c === "\n" || c === "\r" && str[ptr + 1] === "\n"))
      ptr++;
    if (banComments || c !== "#")
      break;
    ptr = skipComment(str, ptr);
  }
  return ptr;
}
function skipUntil(str, ptr, sep4, end, banNewLines = false) {
  if (!end) {
    ptr = indexOfNewline(str, ptr);
    return ptr < 0 ? str.length : ptr;
  }
  for (let i = ptr; i < str.length; i++) {
    let c = str[i];
    if (c === "#") {
      i = indexOfNewline(str, i);
    } else if (c === sep4) {
      return i + 1;
    } else if (c === end || banNewLines && (c === "\n" || c === "\r" && str[i + 1] === "\n")) {
      return i;
    }
  }
  throw new TomlError("cannot find end of structure", {
    toml: str,
    ptr
  });
}

// node_modules/smol-toml/dist/extract.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function sliceAndTrimEndOf(str, startPtr, endPtr) {
  let value = str.slice(startPtr, endPtr);
  let commentIdx = value.indexOf("#");
  if (commentIdx > -1) {
    skipComment(str, commentIdx);
    value = value.slice(0, commentIdx);
  }
  return [value.trimEnd(), commentIdx];
}
function extractValue(str, ptr, end, depth, integersAsBigInt) {
  if (depth === 0) {
    throw new TomlError("document contains excessively nested structures. aborting.", {
      toml: str,
      ptr
    });
  }
  let c = str[ptr];
  if (c === "[" || c === "{") {
    let [value, endPtr2] = c === "[" ? parseArray(str, ptr, depth, integersAsBigInt) : parseInlineTable(str, ptr, depth, integersAsBigInt);
    if (end) {
      endPtr2 = skipVoid(str, endPtr2);
      if (str[endPtr2] === ",")
        endPtr2++;
      else if (str[endPtr2] !== end) {
        throw new TomlError("expected comma or end of structure", {
          toml: str,
          ptr: endPtr2
        });
      }
    }
    return [value, endPtr2];
  }
  if (c === '"' || c === "'") {
    let [parsed, endPtr2] = parseString(str, ptr);
    if (end) {
      endPtr2 = skipVoid(str, endPtr2);
      if (str[endPtr2] && str[endPtr2] !== "," && str[endPtr2] !== end && str[endPtr2] !== "\n" && str[endPtr2] !== "\r") {
        throw new TomlError("unexpected character encountered", {
          toml: str,
          ptr: endPtr2
        });
      }
      if (str[endPtr2] === ",")
        endPtr2++;
    }
    return [parsed, endPtr2];
  }
  let endPtr = skipUntil(str, ptr, ",", end);
  let slice = sliceAndTrimEndOf(str, ptr, endPtr - (str[endPtr - 1] === "," ? 1 : 0));
  if (!slice[0]) {
    throw new TomlError("incomplete key-value declaration: no value specified", {
      toml: str,
      ptr
    });
  }
  if (end && slice[1] > -1) {
    endPtr = skipVoid(str, ptr + slice[1]);
    if (str[endPtr] === ",")
      endPtr++;
  }
  return [
    parseValue(slice[0], str, ptr, integersAsBigInt),
    endPtr
  ];
}

// node_modules/smol-toml/dist/struct.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var KEY_PART_RE = /^[a-zA-Z0-9-_]+[ \t]*$/;
function parseKey(str, ptr, end = "=") {
  let dot = ptr - 1;
  let parsed = [];
  let endPtr = str.indexOf(end, ptr);
  if (endPtr < 0) {
    throw new TomlError("incomplete key-value: cannot find end of key", {
      toml: str,
      ptr
    });
  }
  do {
    let c = str[ptr = ++dot];
    if (c !== " " && c !== "	") {
      if (c === '"' || c === "'") {
        if (c === str[ptr + 1] && c === str[ptr + 2]) {
          throw new TomlError("multiline strings are not allowed in keys", {
            toml: str,
            ptr
          });
        }
        let [part, eos] = parseString(str, ptr);
        dot = str.indexOf(".", eos);
        let strEnd = str.slice(eos, dot < 0 || dot > endPtr ? endPtr : dot);
        let newLine = indexOfNewline(strEnd);
        if (newLine > -1) {
          throw new TomlError("newlines are not allowed in keys", {
            toml: str,
            ptr: ptr + dot + newLine
          });
        }
        if (strEnd.trimStart()) {
          throw new TomlError("found extra tokens after the string part", {
            toml: str,
            ptr: eos
          });
        }
        if (endPtr < eos) {
          endPtr = str.indexOf(end, eos);
          if (endPtr < 0) {
            throw new TomlError("incomplete key-value: cannot find end of key", {
              toml: str,
              ptr
            });
          }
        }
        parsed.push(part);
      } else {
        dot = str.indexOf(".", ptr);
        let part = str.slice(ptr, dot < 0 || dot > endPtr ? endPtr : dot);
        if (!KEY_PART_RE.test(part)) {
          throw new TomlError("only letter, numbers, dashes and underscores are allowed in keys", {
            toml: str,
            ptr
          });
        }
        parsed.push(part.trimEnd());
      }
    }
  } while (dot + 1 && dot < endPtr);
  return [parsed, skipVoid(str, endPtr + 1, true, true)];
}
function parseInlineTable(str, ptr, depth, integersAsBigInt) {
  let res = {};
  let seen = /* @__PURE__ */ new Set();
  let c;
  ptr++;
  while ((c = str[ptr++]) !== "}" && c) {
    if (c === ",") {
      throw new TomlError("expected value, found comma", {
        toml: str,
        ptr: ptr - 1
      });
    } else if (c === "#")
      ptr = skipComment(str, ptr);
    else if (c !== " " && c !== "	" && c !== "\n" && c !== "\r") {
      let k;
      let t = res;
      let hasOwn = false;
      let [key, keyEndPtr] = parseKey(str, ptr - 1);
      for (let i = 0; i < key.length; i++) {
        if (i)
          t = hasOwn ? t[k] : t[k] = {};
        k = key[i];
        if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
          throw new TomlError("trying to redefine an already defined value", {
            toml: str,
            ptr
          });
        }
        if (!hasOwn && k === "__proto__") {
          Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        }
      }
      if (hasOwn) {
        throw new TomlError("trying to redefine an already defined value", {
          toml: str,
          ptr
        });
      }
      let [value, valueEndPtr] = extractValue(str, keyEndPtr, "}", depth - 1, integersAsBigInt);
      seen.add(value);
      t[k] = value;
      ptr = valueEndPtr;
    }
  }
  if (!c) {
    throw new TomlError("unfinished table encountered", {
      toml: str,
      ptr
    });
  }
  return [res, ptr];
}
function parseArray(str, ptr, depth, integersAsBigInt) {
  let res = [];
  let c;
  ptr++;
  while ((c = str[ptr++]) !== "]" && c) {
    if (c === ",") {
      throw new TomlError("expected value, found comma", {
        toml: str,
        ptr: ptr - 1
      });
    } else if (c === "#")
      ptr = skipComment(str, ptr);
    else if (c !== " " && c !== "	" && c !== "\n" && c !== "\r") {
      let e = extractValue(str, ptr - 1, "]", depth - 1, integersAsBigInt);
      res.push(e[0]);
      ptr = e[1];
    }
  }
  if (!c) {
    throw new TomlError("unfinished array encountered", {
      toml: str,
      ptr
    });
  }
  return [res, ptr];
}

// node_modules/smol-toml/dist/parse.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function peekTable(key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = {};
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      if (k === "__proto__") {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: {}
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = {});
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: {} };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = {};
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function parse(toml, { maxDepth = 1e3, integersAsBigInt } = {}) {
  let res = {};
  let meta = {};
  let tbl = res;
  let m = meta;
  for (let ptr = skipVoid(toml, 0); ptr < toml.length; ) {
    if (toml[ptr] === "[") {
      let isTableArray = toml[++ptr] === "[";
      let k = parseKey(toml, ptr += +isTableArray, "]");
      if (isTableArray) {
        if (toml[k[1] - 1] !== "]") {
          throw new TomlError("expected end of table declaration", {
            toml,
            ptr: k[1] - 1
          });
        }
        k[1]++;
      }
      let p = peekTable(
        k[0],
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr
        });
      }
      m = p[2];
      tbl = p[1];
      ptr = k[1];
    } else {
      let k = parseKey(toml, ptr);
      let p = peekTable(
        k[0],
        tbl,
        m,
        0
        /* Type.DOTTED */
      );
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr
        });
      }
      let v = extractValue(toml, k[1], void 0, maxDepth, integersAsBigInt);
      p[1][p[0]] = v[0];
      ptr = v[1];
    }
    ptr = skipVoid(toml, ptr, true);
    if (toml[ptr] && toml[ptr] !== "\n" && toml[ptr] !== "\r") {
      throw new TomlError("each key-value declaration must be followed by an end-of-line", {
        toml,
        ptr
      });
    }
    ptr = skipVoid(toml, ptr);
  }
  return res;
}

// node_modules/smol-toml/dist/stringify.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// node_modules/smol-toml/dist/index.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// packages/lsp-tools-mcp/dist/lsp/cargo-metadata-parser.js
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function canonicalDirectory(path) {
  try {
    const canonicalPath = realpathSync.native(path);
    return statSync2(canonicalPath).isDirectory() ? canonicalPath : void 0;
  } catch {
    return void 0;
  }
}
function canonicalManifest(path) {
  try {
    const canonicalPath = realpathSync.native(path);
    return statSync2(canonicalPath).isFile() ? canonicalPath : void 0;
  } catch {
    return void 0;
  }
}
function readFile2(path) {
  try {
    return readFileSync4(path, "utf8");
  } catch {
    return void 0;
  }
}
function readCargoManifestKind(path) {
  const content = readFile2(path);
  if (content === void 0)
    return void 0;
  try {
    return Object.hasOwn(parse(content), "workspace") ? "workspace" : "ordinary";
  } catch {
    return "invalid";
  }
}
function isContainedPath(root, path) {
  const relativePath = relative2(root, path);
  return relativePath === "" || !isAbsolute3(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep2}`);
}
function parseCargoMetadata(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return void 0;
  }
  if (!isRecord3(parsed))
    return void 0;
  const workspaceRoot = parsed["workspace_root"];
  const workspaceMembers = parsed["workspace_members"];
  const packages = parsed["packages"];
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0)
    return void 0;
  if (!Array.isArray(workspaceMembers) || !Array.isArray(packages))
    return void 0;
  const memberIds = /* @__PURE__ */ new Set();
  for (const id of workspaceMembers) {
    if (typeof id !== "string")
      return void 0;
    memberIds.add(id);
  }
  const memberManifestPaths = [];
  for (const pkg of packages) {
    if (!isRecord3(pkg))
      return void 0;
    const id = pkg["id"];
    const manifestPath = pkg["manifest_path"];
    if (typeof id !== "string" || typeof manifestPath !== "string")
      return void 0;
    if (memberIds.has(id))
      memberManifestPaths.push(manifestPath);
  }
  if (memberManifestPaths.length !== memberIds.size)
    return void 0;
  return { workspaceRoot, memberManifestPaths };
}
function validateCargoMetadata(requestedManifestPath, metadata) {
  const workspaceRoot = canonicalDirectory(metadata.workspaceRoot);
  if (workspaceRoot === void 0)
    return void 0;
  const rootManifestPath = canonicalManifest(join6(workspaceRoot, "Cargo.toml"));
  const requestedManifest = canonicalManifest(requestedManifestPath);
  if (rootManifestPath === void 0 || requestedManifest === void 0)
    return void 0;
  if (!isContainedPath(workspaceRoot, requestedManifest))
    return void 0;
  const rootManifestKind = readCargoManifestKind(rootManifestPath);
  const requestedManifestKind = requestedManifest === rootManifestPath ? rootManifestKind : readCargoManifestKind(requestedManifest);
  if (rootManifestKind === void 0 || rootManifestKind === "invalid")
    return void 0;
  if (requestedManifestKind === void 0 || requestedManifestKind === "invalid")
    return void 0;
  if (requestedManifest !== rootManifestPath && requestedManifestKind === "workspace")
    return void 0;
  const memberManifestPaths = [];
  const members = /* @__PURE__ */ new Set();
  for (const manifestPath of metadata.memberManifestPaths) {
    const canonicalPath = canonicalManifest(manifestPath);
    if (canonicalPath === void 0)
      return void 0;
    if (!isContainedPath(workspaceRoot, canonicalPath))
      return void 0;
    const manifestKind = canonicalPath === rootManifestPath ? rootManifestKind : readCargoManifestKind(canonicalPath);
    if (manifestKind === void 0)
      return void 0;
    if (canonicalPath !== rootManifestPath && manifestKind !== "ordinary")
      continue;
    if (!members.has(canonicalPath)) {
      members.add(canonicalPath);
      memberManifestPaths.push(canonicalPath);
    }
  }
  if (requestedManifest !== rootManifestPath && !members.has(requestedManifest))
    return void 0;
  return { workspaceRoot, rootManifestPath, memberManifestPaths };
}
function parseTrustedCargoMetadata(requestedManifestPath, output) {
  const parsed = parseCargoMetadata(output);
  return parsed === void 0 ? void 0 : validateCargoMetadata(requestedManifestPath, parsed);
}

// packages/lsp-tools-mcp/dist/lsp/cargo-metadata-process.js
import { spawn as spawn2 } from "node:child_process";
var CARGO_METADATA_MAX_BUFFER = 64 * 1024 * 1024;
var CARGO_METADATA_TIMEOUT_MS = 1e4;
var CARGO_METADATA_FORCE_KILL_DELAY_MS = 250;
var activeCargoMetadataCleanups = /* @__PURE__ */ new Set();
var removeProcessSignalHandlers;
async function abortActiveCargoMetadata() {
  const cleanups = [...activeCargoMetadataCleanups];
  for (const cleanup of cleanups) {
    if (!cleanup.controller.signal.aborted)
      cleanup.controller.abort();
  }
  await Promise.all(cleanups.map((cleanup) => cleanup.waitForTermination()));
}
function ensureProcessSignalHandlers() {
  if (removeProcessSignalHandlers !== void 0)
    return;
  removeProcessSignalHandlers = installProcessSignalCleanup(abortActiveCargoMetadata);
}
function registerCargoMetadataCleanup(controller, waitForTermination) {
  activeCargoMetadataCleanups.add({ controller, waitForTermination });
}
function releaseCargoMetadataController(controller) {
  for (const cleanup of activeCargoMetadataCleanups) {
    if (cleanup.controller === controller)
      activeCargoMetadataCleanups.delete(cleanup);
  }
  if (activeCargoMetadataCleanups.size > 0)
    return;
  removeProcessSignalHandlers?.();
  removeProcessSignalHandlers = void 0;
}
function linkParentSignal(controller, signal) {
  if (signal === void 0)
    return () => {
    };
  const abortFromParent = () => controller.abort(signal.reason);
  if (signal.aborted) {
    abortFromParent();
    return () => {
    };
  }
  signal.addEventListener("abort", abortFromParent, { once: true });
  return () => signal.removeEventListener("abort", abortFromParent);
}
async function defaultCargoMetadataLoader(manifestPath, signal) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const unlinkParentSignal = linkParentSignal(controller, signal);
  ensureProcessSignalHandlers();
  try {
    controller.signal.throwIfAborted();
    return await new Promise((resolveLoader, rejectLoader) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let cargoProcess;
      let cleanupStarted = false;
      let forceKillTimeout;
      let timeoutError;
      let terminationError;
      let settled = false;
      let resolveTermination;
      const terminationComplete = new Promise((resolve6) => {
        resolveTermination = resolve6;
      });
      const finishTermination = () => {
        resolveTermination?.();
        resolveTermination = void 0;
      };
      const terminateCargoProcessTree = (terminationSignal) => {
        if (cargoProcess !== void 0)
          terminateProcessTree(cargoProcess, terminationSignal);
      };
      const beginCargoCleanup = () => {
        if (cleanupStarted)
          return;
        cleanupStarted = true;
        terminateCargoProcessTree("SIGTERM");
        forceKillTimeout = setTimeout(() => {
          forceKillTimeout = void 0;
          terminateCargoProcessTree("SIGKILL");
          finishTermination();
        }, CARGO_METADATA_FORCE_KILL_DELAY_MS);
      };
      const clearCleanupTracking = () => {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", beginCargoCleanup);
        if (!cleanupStarted) {
          if (forceKillTimeout !== void 0) {
            clearTimeout(forceKillTimeout);
            forceKillTimeout = void 0;
          }
          finishTermination();
          return;
        }
        if (forceKillTimeout === void 0)
          finishTermination();
      };
      const timeout = setTimeout(() => {
        timeoutError = new Error(`cargo metadata timed out after ${CARGO_METADATA_TIMEOUT_MS}ms`);
        timeoutError.name = "TimeoutError";
        beginCargoCleanup();
      }, CARGO_METADATA_TIMEOUT_MS);
      controller.signal.addEventListener("abort", beginCargoCleanup, { once: true });
      registerCargoMetadataCleanup(controller, () => terminationComplete);
      const commandArgs = ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifestPath];
      const rejectWithCurrentReason = (error) => {
        rejectLoader(controller.signal.aborted ? controller.signal.reason : error);
      };
      const settle = (callback) => {
        if (settled)
          return;
        settled = true;
        callback();
      };
      const appendChunk = (chunks, chunk, currentBytes) => {
        const nextBytes = currentBytes + Buffer.byteLength(chunk, "utf8");
        if (nextBytes > CARGO_METADATA_MAX_BUFFER && terminationError === void 0) {
          terminationError = new RangeError("cargo metadata output exceeded maxBuffer");
          beginCargoCleanup();
        }
        chunks.push(chunk);
        return nextBytes;
      };
      cargoProcess = spawn2("cargo", commandArgs, {
        detached: process.platform !== "win32",
        signal: controller.signal,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      cargoProcess.stdout?.setEncoding("utf8");
      cargoProcess.stderr?.setEncoding("utf8");
      cargoProcess.stdout?.on("data", (chunk) => {
        stdoutBytes = appendChunk(stdoutChunks, chunk, stdoutBytes);
      });
      cargoProcess.stderr?.on("data", (chunk) => {
        stderrBytes = appendChunk(stderrChunks, chunk, stderrBytes);
      });
      cargoProcess.once("error", (error) => {
        settle(() => {
          clearCleanupTracking();
          if (controller.signal.aborted) {
            rejectWithCurrentReason(error);
            return;
          }
          rejectLoader(error);
        });
      });
      cargoProcess.once("close", (code, closeSignal) => {
        settle(() => {
          clearCleanupTracking();
          if (controller.signal.aborted) {
            rejectWithCurrentReason(timeoutError);
            return;
          }
          if (timeoutError !== void 0) {
            rejectLoader(timeoutError);
            return;
          }
          if (terminationError !== void 0) {
            rejectLoader(terminationError);
            return;
          }
          if (code === 0 && closeSignal === null) {
            resolveLoader(stdoutChunks.join(""));
            return;
          }
          const stderrOutput = stderrChunks.join("").trim();
          const exitDetail = closeSignal === null ? `exit code ${code ?? 0}` : `signal ${closeSignal}`;
          rejectLoader(new Error(stderrOutput.length > 0 ? `cargo metadata failed with ${exitDetail}: ${stderrOutput}` : `cargo metadata failed with ${exitDetail}`));
        });
      });
    });
  } finally {
    unlinkParentSignal();
    releaseCargoMetadataController(controller);
  }
}

// packages/lsp-tools-mcp/dist/lsp/cargo-workspace-root.js
var CARGO_METADATA_FAILURE_BACKOFF_MS = 1e3;
var cargoWorkspaceRootCache = /* @__PURE__ */ new Map();
var cargoWorkspaceRootFailures = /* @__PURE__ */ new Map();
var cargoWorkspaceRootInFlight = /* @__PURE__ */ new Map();
function realpathSafe(path) {
  try {
    return realpathSync2.native(path);
  } catch {
    return path;
  }
}
function nearestCargoManifestDir(startDir) {
  let dir = startDir;
  let prev = "";
  while (dir !== prev) {
    if (existsSync4(join7(dir, "Cargo.toml")))
      return dir;
    prev = dir;
    dir = dirname2(dir);
  }
  return void 0;
}
function cacheEntryFor(root, memberManifestDir) {
  const snapshots = readAncestorManifestSnapshots(memberManifestDir);
  return snapshots === void 0 ? void 0 : { root, snapshots };
}
function prepareCargoWorkspaceCache(manifestDir, metadata) {
  const entries = /* @__PURE__ */ new Map();
  for (const manifestPath of metadata.memberManifestPaths) {
    const manifestDir2 = dirname2(manifestPath);
    const entry = cacheEntryFor(metadata.workspaceRoot, manifestDir2);
    if (entry === void 0)
      return void 0;
    entries.set(manifestDir2, entry);
  }
  const requestedManifestPath = canonicalManifest(join7(manifestDir, "Cargo.toml"));
  if (requestedManifestPath === void 0)
    return void 0;
  const requestedEntry = cacheEntryFor(metadata.workspaceRoot, dirname2(requestedManifestPath));
  if (requestedEntry === void 0)
    return void 0;
  entries.set(manifestDir, requestedEntry);
  return { root: metadata.workspaceRoot, entries };
}
function preparedCacheIsFresh(prepared) {
  for (const entry of prepared.entries.values()) {
    if (!snapshotsAreFresh(entry.snapshots))
      return false;
  }
  return true;
}
function commitCargoWorkspaceCache(prepared) {
  for (const [manifestDir, entry] of prepared.entries) {
    cargoWorkspaceRootCache.set(manifestDir, entry);
  }
}
function cacheCargoWorkspaceFailure(manifestDir, nowMs, snapshots) {
  cargoWorkspaceRootFailures.set(manifestDir, {
    expiresAtMs: nowMs + CARGO_METADATA_FAILURE_BACKOFF_MS,
    snapshots
  });
}
function cacheCargoWorkspaceLoadFailure(request2) {
  cacheCargoWorkspaceFailure(request2.manifestDir, request2.now(), request2.generation.snapshots);
}
function cachedCargoWorkspaceFailure(manifestDir, nowMs) {
  const cached = cargoWorkspaceRootFailures.get(manifestDir);
  if (cached === void 0)
    return false;
  if (nowMs >= cached.expiresAtMs) {
    cargoWorkspaceRootFailures.delete(manifestDir);
    return false;
  }
  if (snapshotsAreFresh(cached.snapshots))
    return true;
  cargoWorkspaceRootFailures.delete(manifestDir);
  return false;
}
function isAbortError(error) {
  if (error instanceof DOMException && error.name === "AbortError")
    return true;
  return error instanceof Error && error.name === "AbortError";
}
function sameCargoWorkspaceGeneration(left, right) {
  if (left.snapshots.length !== right.snapshots.length)
    return false;
  return left.snapshots.every((snapshot, index) => {
    const candidate = right.snapshots[index];
    return candidate !== void 0 && candidate.path === snapshot.path && candidate.exists === snapshot.exists && candidate.content === snapshot.content;
  });
}
function deleteInFlight(manifestDir, inFlight) {
  if (cargoWorkspaceRootInFlight.get(manifestDir)?.operation === inFlight) {
    cargoWorkspaceRootInFlight.delete(manifestDir);
  }
}
function createInFlightCargoWorkspaceRoot(request2) {
  let inFlight;
  inFlight = createSharedAbortableOperation((signal) => loadCargoWorkspaceRoot({ ...request2, signal }), () => {
    deleteInFlight(request2.manifestDir, inFlight);
  }, () => {
    deleteInFlight(request2.manifestDir, inFlight);
  });
  return inFlight;
}
async function loadCargoWorkspaceRoot(request2) {
  try {
    request2.signal?.throwIfAborted();
    const manifestPath = join7(request2.manifestDir, "Cargo.toml");
    const output = await request2.loader(manifestPath, request2.signal);
    request2.signal?.throwIfAborted();
    if (!snapshotsAreFresh(request2.generation.snapshots)) {
      cacheCargoWorkspaceLoadFailure(request2);
      return void 0;
    }
    const metadata = parseTrustedCargoMetadata(manifestPath, output);
    if (metadata === void 0 || !snapshotsAreFresh(request2.generation.snapshots)) {
      cacheCargoWorkspaceLoadFailure(request2);
      return void 0;
    }
    const prepared = prepareCargoWorkspaceCache(request2.manifestDir, metadata);
    if (prepared === void 0 || !snapshotsAreFresh(request2.generation.snapshots) || !preparedCacheIsFresh(prepared)) {
      cacheCargoWorkspaceLoadFailure(request2);
      return void 0;
    }
    commitCargoWorkspaceCache(prepared);
    cargoWorkspaceRootFailures.delete(request2.manifestDir);
    return prepared.root;
  } catch (error) {
    if (request2.signal?.aborted || isAbortError(error))
      throw error;
    cacheCargoWorkspaceLoadFailure(request2);
    return void 0;
  }
}
function cachedCargoWorkspaceRoot(manifestDir) {
  const cached = cargoWorkspaceRootCache.get(manifestDir);
  if (cached === void 0)
    return void 0;
  if (snapshotsAreFresh(cached.snapshots))
    return cached.root;
  cargoWorkspaceRootCache.delete(manifestDir);
  return void 0;
}
async function cargoWorkspaceRoot(request2) {
  request2.signal?.throwIfAborted();
  const cached = cachedCargoWorkspaceRoot(request2.manifestDir);
  if (cached !== void 0)
    return cached;
  const nowMs = request2.now();
  if (cachedCargoWorkspaceFailure(request2.manifestDir, nowMs))
    return void 0;
  const snapshots = readAncestorManifestSnapshots(request2.manifestDir);
  if (snapshots === void 0)
    return void 0;
  const generation = { snapshots };
  const inFlight = cargoWorkspaceRootInFlight.get(request2.manifestDir);
  if (inFlight !== void 0 && sameCargoWorkspaceGeneration(inFlight.generation, generation)) {
    return awaitSharedAbortableOperation(inFlight.operation, request2.signal);
  }
  const newInFlight = createInFlightCargoWorkspaceRoot({ ...request2, generation });
  cargoWorkspaceRootInFlight.set(request2.manifestDir, { generation, operation: newInFlight });
  return awaitSharedAbortableOperation(newInFlight, request2.signal);
}
async function resolveCargoWorkspaceRoot(startDir, options = {}) {
  const manifestDir = nearestCargoManifestDir(realpathSafe(startDir));
  if (manifestDir === void 0)
    return void 0;
  const canonicalManifestDir = realpathSafe(manifestDir);
  const root = await cargoWorkspaceRoot({
    manifestDir: canonicalManifestDir,
    loader: options.cargoMetadataLoader ?? defaultCargoMetadataLoader,
    now: options.now ?? Date.now,
    signal: options.signal
  });
  return root ?? canonicalManifestDir;
}

// packages/lsp-tools-mcp/dist/lsp/workspace-root.js
var WORKSPACE_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"];
function isDirectoryPath(filePath) {
  try {
    return statSync3(filePath).isDirectory();
  } catch {
    return false;
  }
}
async function findWorkspaceRoot(filePath, server, options = {}) {
  const abs = resolve3(filePath);
  let dir = abs;
  if (!isDirectoryPath(dir)) {
    dir = dirname3(dir);
  }
  if (server?.id === "rust") {
    const cargoRoot = await resolveCargoWorkspaceRoot(dir, options);
    if (cargoRoot !== void 0)
      return cargoRoot;
  }
  let prevDir = "";
  while (dir !== prevDir) {
    for (const marker of WORKSPACE_MARKERS) {
      if (existsSync5(join8(dir, marker))) {
        return dir;
      }
    }
    prevDir = dir;
    dir = dirname3(dir);
  }
  return dirname3(abs);
}

// packages/lsp-tools-mcp/dist/lsp/client-wrapper.js
function isDirectoryPath2(filePath) {
  try {
    return statSync4(filePath).isDirectory();
  } catch {
    return false;
  }
}
function formatServerLookupError(result) {
  if (result.status === "not_installed") {
    const { server, installHint } = result;
    return [
      `LSP server '${server.id}' is configured but NOT INSTALLED.`,
      "",
      `Command not found: ${server.command[0]}`,
      "",
      "To install:",
      `  ${installHint}`,
      "",
      `Supported extensions: ${server.extensions.join(", ")}`,
      "",
      "After installation, the server will be available automatically."
    ].join("\n");
  }
  return [
    `No LSP server configured for extension: ${result.extension}`,
    "",
    `Available servers: ${result.availableServers.slice(0, 10).join(", ")}${result.availableServers.length > 10 ? "..." : ""}`,
    "",
    "Configure a custom server in '.codex/lsp-client.json':",
    "  {",
    '    "lsp": {',
    '      "my-server": {',
    '        "command": ["my-lsp", "--stdio"],',
    `        "extensions": ["${result.extension}"]`,
    "      }",
    "    }",
    "  }"
  ].join("\n");
}
var READ_ONLY_RETRY_TOOLS = /* @__PURE__ */ new Set([
  "diagnostics",
  "definition",
  "references",
  "documentSymbols",
  "workspaceSymbols",
  "prepareRename"
]);
async function withLspClient(filePath, fn, toolName, options = {}) {
  const absPath = resolve4(filePath);
  if (isDirectoryPath2(absPath)) {
    throw new LspInvalidPathError("Directory paths are not supported by this LSP tool. Use lsp.diagnostics with a directory path for directory diagnostics.");
  }
  const ext = extname2(absPath);
  const result = findServerForExtension(ext);
  if (result.status !== "found") {
    throw new LspServerLookupError(formatServerLookupError(result));
  }
  const server = result.server;
  const { manager: optionManager, ...workspaceRootOptions } = options;
  const root = await findWorkspaceRoot(absPath, server, workspaceRootOptions);
  const manager = optionManager ?? getLspManager();
  const acquireAndCall = async (allowRetry) => {
    const client = await manager.getClient(root, server, options.signal);
    try {
      return await fn(client);
    } catch (err) {
      if (allowRetry && READ_ONLY_RETRY_TOOLS.has(toolName) && isLspDeadConnectionError(err)) {
        manager.invalidateClient(root, server.id, client);
        return acquireAndCall(false);
      }
      if (err instanceof LspRequestTimeoutError) {
        if (manager.isServerInitializing(root, server.id)) {
          throw new LspServerInitializingError(err);
        }
      }
      throw err;
    } finally {
      manager.releaseClient(root, server.id);
    }
  };
  return acquireAndCall(true);
}

// src/language.ts
var Client = class extends LspClient {
  constructor() {
    super(...arguments);
    this.published = /* @__PURE__ */ new Map();
    this.versions = /* @__PURE__ */ new Map();
  }
  async start() {
    await super.start();
    this.connection?.onNotification("textDocument/publishDiagnostics", (value) => {
      if (!record(value) || typeof value["uri"] !== "string" || !Array.isArray(value["diagnostics"])) return;
      const items2 = value["diagnostics"];
      const version = value["version"];
      this.published.set(value["uri"], typeof version === "number" ? { version, items: items2 } : { items: items2 });
    });
  }
  async openFile(path) {
    const uri = pathToFileURL3(path).href;
    const content = await readFile3(path, "utf8");
    const previous = this.versions.get(uri);
    if (previous?.content === content) return;
    this.published.delete(uri);
    const version = (previous?.version ?? 0) + 1;
    this.versions.set(uri, { content, version });
    if (previous) {
      await this.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }]
      });
    } else {
      await this.sendNotification("textDocument/didOpen", {
        textDocument: { uri, version, languageId: getLanguageId(extname3(path)), text: content }
      });
    }
  }
  async refresh(paths) {
    for (const uri of this.versions.keys())
      await this.sendNotification("textDocument/didClose", { textDocument: { uri } });
    this.versions.clear();
    this.published.clear();
    await this.sendNotification("workspace/didChangeWatchedFiles", {
      changes: paths.map((path) => ({ uri: pathToFileURL3(path).href, type: 2 }))
    });
  }
  async collect(path) {
    const uri = pathToFileURL3(path).href;
    await this.openFile(path);
    await this.sendNotification("textDocument/didSave", { textDocument: { uri } });
    try {
      const result = await this.sendRequest("textDocument/diagnostic", {
        textDocument: { uri }
      });
      if (Array.isArray(result.items)) return { items: result.items, ready: true };
    } catch (error) {
      if (!(record(error) && error["code"] === -32601) && !/method not found|unsupported|not supported|unknown request|unhandled method/i.test(message(error)))
        throw error;
    }
    for (let i = 0; i < 40; i++) {
      const result = this.published.get(uri);
      if (result && (result.version === void 0 || result.version === this.versions.get(uri)?.version))
        return { items: result.items, ready: true };
      await new Promise((resolve6) => setTimeout(resolve6, 50));
    }
    return { items: [], ready: false };
  }
  async formatting(path) {
    await this.openFile(path);
    return await this.sendRequest("textDocument/formatting", {
      textDocument: { uri: pathToFileURL3(path).href },
      options: { tabSize: 4, insertSpaces: true }
    }) ?? [];
  }
};
var Languages = class {
  constructor(root) {
    this.root = root;
    this.clients = /* @__PURE__ */ new Set();
    this.snapshot = /* @__PURE__ */ new Map();
    this.manager = new LspManager({
      clientFactory: (root2, server) => {
        if (!inside(this.root, root2))
          throw new Error("LSP root outside workspace; choose the enclosing project as workspace");
        const client = new Client(root2, server);
        this.clients.add(client);
        return client;
      }
    });
  }
  async sync(files) {
    const changed = [.../* @__PURE__ */ new Set([...files.keys(), ...this.snapshot.keys()])].filter(
      (path) => files.get(path) !== this.snapshot.get(path)
    );
    this.snapshot = new Map(files);
    for (const client of this.clients) {
      if (!client.isAlive()) {
        this.clients.delete(client);
        continue;
      }
      await client.refresh(changed.map((path) => resolve5(this.root, path)));
    }
  }
  async check(path, signal) {
    try {
      return await withLspClient(
        await workspacePath(this.root, path),
        async (client) => {
          if (!(client instanceof Client)) throw new Error("Unexpected LSP client");
          const result = await client.collect(await workspacePath(this.root, path));
          return {
            path,
            state: result.ready ? "complete" : "pending",
            findings: result.items.filter((item) => item.severity === 1 || item.severity === 2).map((item) => ({
              path,
              line: item.range.start.line + 1,
              column: item.range.start.character + 1,
              severity: item.severity === 1 ? "error" : "warning",
              source: `${item.source ?? "lsp"}${item.code === void 0 ? "" : `/${item.code}`}`,
              message: item.message
            })),
            ...!result.ready ? { note: "No fresh diagnostics published yet" } : {}
          };
        },
        "diagnostics",
        { manager: this.manager, signal }
      );
    } catch (error) {
      const note = message(error);
      return { path, state: /No LSP server|NOT INSTALLED/.test(note) ? "skipped" : "failed", findings: [], note };
    }
  }
  async navigate(args, signal) {
    const path = await workspacePath(this.root, text(args["path"]));
    const operation = text(args["operation"]);
    const line = number(args["line"], 1, 1, 1e7);
    const column = number(args["column"], 1, 1, 1e6) - 1;
    const before = operation === "rename" ? await inventory(this.root) : void 0;
    return withLspClient(
      path,
      async (client) => {
        let result;
        switch (operation) {
          case "definition":
            result = await client.definition(path, line, column);
            break;
          case "references":
            result = await client.references(path, line, column);
            break;
          case "symbols":
            result = args["query"] ? await client.workspaceSymbols(text(args["query"])) : await client.documentSymbols(path);
            break;
          case "prepare_rename":
            result = await client.prepareRename(path, line, column);
            break;
          case "rename": {
            if (!before?.complete) throw new Error("Cannot safely snapshot workspace for rename");
            const name = text(args["newName"]);
            if (!name) throw new Error("newName required");
            const edit = await client.rename(path, line, column, name);
            return this.applyRename(edit, before.version, signal);
          }
          default:
            throw new Error("Unknown navigation operation");
        }
        const output = JSON.stringify(result ?? []);
        return output.length <= 8e3 ? output : `${output.slice(0, 7800)}
(truncated; narrow query/path)`;
      },
      operation,
      { manager: this.manager, signal }
    );
  }
  async applyRename(edit, version, signal) {
    if (!edit) return "No rename edits";
    const changes = /* @__PURE__ */ new Map();
    for (const [uri, edits] of Object.entries(edit.changes ?? {})) changes.set(uri, edits);
    for (const change of edit.documentChanges ?? []) {
      if ("kind" in change) throw new Error("Resource operations are not permitted by rename");
      if (changes.has(change.textDocument.uri)) throw new Error("Duplicate rename target");
      changes.set(change.textDocument.uri, change.edits);
    }
    const pending = [];
    for (const [uri, edits] of changes) {
      const path = await workspacePath(this.root, fileURLToPath(uri));
      const before = await readFile3(path, "utf8");
      pending.push({ path, before, after: applyTextChanges(before, edits) });
    }
    if ((await inventory(this.root)).version !== version) throw new Error("Workspace changed during rename; retry");
    for (const item of pending)
      if (await readFile3(item.path, "utf8") !== item.before) throw new Error("Rename conflict");
    signal.throwIfAborted();
    for (const item of pending) await writeFile(item.path, item.after);
    return `Renamed: ${pending.map((item) => relative3(this.root, item.path)).join(", ")}`;
  }
  async format(path, signal) {
    const absolute = await workspacePath(this.root, path);
    const before = await readFile3(absolute, "utf8");
    const edits = await withLspClient(
      absolute,
      async (client) => {
        if (!(client instanceof Client)) throw new Error("Unexpected LSP client");
        return client.formatting(absolute);
      },
      "format",
      { manager: this.manager, signal }
    );
    const after = applyTextChanges(before, edits);
    if (await readFile3(absolute, "utf8") !== before) throw new Error("File changed during formatting; retry");
    if (after === before) return `Unchanged: ${path}`;
    signal.throwIfAborted();
    await writeFile(absolute, after);
    return `Formatted: ${path}`;
  }
  async close() {
    await this.manager.stopAll();
  }
};

// src/runners.ts
import { spawn as spawn3 } from "node:child_process";
import { access, readFile as readFile4, writeFile as writeFile2 } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname4, extname as extname4, join as join9 } from "node:path";

// src/lint-output.ts
function position(value, content) {
  const location = record(value["location"]) ? value["location"] : {};
  const span = location["span"];
  if (Array.isArray(span) && typeof span[0] === "number") {
    const before = Buffer.from(content).subarray(0, span[0]).toString("utf8").split("\n");
    return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
  }
  const start = record(location["start"]) ? location["start"] : {};
  const line = value["line"] ?? location["row"] ?? start["line"];
  const column = value["column"] ?? location["column"] ?? start["column"];
  return { line: typeof line === "number" ? line : 1, column: typeof column === "number" ? column : 1 };
}
function items(runner, data) {
  if (runner === "eslint" && Array.isArray(data))
    return data.flatMap((file) => record(file) && Array.isArray(file["messages"]) ? file["messages"] : []);
  if (runner === "ruff" && Array.isArray(data)) return data;
  if (runner === "biome" && record(data) && Array.isArray(data["diagnostics"])) {
    const summary = data["summary"];
    if (record(summary) && Number(summary["diagnosticsNotPrinted"]) > 0)
      throw new Error("Lint result truncated; narrow file scope");
    return data["diagnostics"];
  }
  throw new Error("Unexpected lint output");
}
function parseLint(runner, data, path, content) {
  const findings = [];
  for (const value of items(runner, data)) {
    if (!record(value)) throw new Error("Malformed lint finding");
    const severity = value["severity"];
    if (severity !== void 0 && ![1, 2, "error", "warning", "fatal"].includes(severity))
      continue;
    findings.push({
      path,
      ...position(value, content),
      severity: severity === 1 || severity === "warning" ? "warning" : "error",
      source: `${runner}/${text(value["ruleId"], text(value["code"], text(value["category"], "lint")))}`,
      message: text(value["description"], text(value["message"], "Lint finding"))
    });
  }
  return findings;
}

// src/runners.ts
async function trusted(root) {
  if (process.env["CODEX_LSP_TRUST_PROJECT"] === "1") return true;
  try {
    const config = JSON.parse(
      await readFile4(join9(process.env["CODEX_HOME"] ?? join9(homedir2(), ".codex"), "lsp-client.json"), "utf8")
    );
    return record(config) && Array.isArray(config["trustedWorkspaces"]) && config["trustedWorkspaces"].includes(root);
  } catch {
    return false;
  }
}
async function run(command, args, cwd, signal, input) {
  return new Promise((resolve6, reject) => {
    const child = spawn3(command, args, { cwd, signal, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const timer = setTimeout(() => {
      exceeded = true;
      child.kill("SIGKILL");
    }, 2e4);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) {
        exceeded = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4e3);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (exceeded) reject(new Error("Runner exceeded time/output budget"));
      else resolve6({ stdout, stderr, code: code ?? -1 });
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(input);
  });
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function configured(root, path, names) {
  let dir = dirname4(path);
  while (inside(root, dir)) {
    for (const name of names) if (await exists(join9(dir, name))) return true;
    if (dir === root) break;
    dir = dirname4(dir);
  }
  return false;
}
async function select(root, path) {
  const extension = extname4(path);
  if (extension === ".py" && await configured(root, path, ["pyproject.toml", "ruff.toml", ".ruff.toml"])) {
    const local = join9(root, ".venv", process.platform === "win32" ? "Scripts/ruff.exe" : "bin/ruff");
    return { name: "ruff", command: await exists(local) ? local : "ruff", prefix: [] };
  }
  if (!/\.(?:[cm]?[jt]sx?|jsonc?|css)$/.test(path)) return void 0;
  const require2 = createRequire(join9(root, "package.json"));
  if (await configured(root, path, ["biome.json", "biome.jsonc"]))
    return { name: "biome", command: process.execPath, prefix: [require2.resolve("@biomejs/biome/bin/biome")] };
  if (await configured(root, path, [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    ".eslintrc.json",
    ".eslintrc.cjs"
  ]))
    return {
      name: "eslint",
      command: process.execPath,
      prefix: [join9(dirname4(require2.resolve("eslint/package.json")), "bin/eslint.js")]
    };
  return void 0;
}
async function lint(root, path, signal) {
  if (!await trusted(root)) return void 0;
  try {
    const absolute = await workspacePath(root, path);
    const runner = await select(root, absolute);
    if (!runner) return void 0;
    const args = runner.name === "biome" ? ["lint", "--reporter=json", "--max-diagnostics=1000", absolute] : runner.name === "eslint" ? ["--format", "json", absolute] : ["check", "--no-cache", "--output-format", "json", "--", absolute];
    const result = await run(runner.command, [...runner.prefix, ...args], root, signal);
    if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || `Runner exit ${result.code}`);
    const data = JSON.parse(result.stdout);
    const findings = parseLint(runner.name, data, path, await readFile4(absolute, "utf8"));
    return { path, state: "complete", findings };
  } catch (error) {
    return { path, state: "failed", findings: [], note: `lint: ${message(error)}` };
  }
}
async function formatWithRunner(root, path, signal) {
  if (!await trusted(root)) return void 0;
  const absolute = await workspacePath(root, path);
  const runner = await select(root, absolute);
  if (!runner || runner.name === "eslint") return void 0;
  const before = await readFile4(absolute, "utf8");
  const args = runner.name === "biome" ? ["format", `--stdin-file-path=${absolute}`] : ["format", "--no-cache", "--stdin-filename", absolute, "-"];
  const result = await run(runner.command, [...runner.prefix, ...args], root, signal, before);
  if (result.code !== 0) throw new Error(result.stderr || "Format failed");
  if (await readFile4(absolute, "utf8") !== before) throw new Error("File changed during format; retry");
  if (before === result.stdout) return `Unchanged: ${path}`;
  signal.throwIfAborted();
  await writeFile2(absolute, result.stdout);
  return `Formatted: ${path}`;
}

// src/engine.ts
var Engine = class {
  constructor(root, checker) {
    this.root = root;
    this.cache = /* @__PURE__ */ new Map();
    this.sessions = /* @__PURE__ */ new Map();
    this.queue = Promise.resolve();
    this.checker = checker ?? (async (path, signal, lspOnly) => {
      this.language ??= new Languages(root);
      const lsp = await this.language.check(path, signal);
      if (lspOnly) return lsp;
      const runner = await lint(root, path, signal);
      if (!runner) return lsp;
      return {
        path,
        state: lsp.state === "complete" ? runner.state : lsp.state,
        findings: [...lsp.findings, ...runner.findings],
        ...lsp.note || runner.note ? { note: [lsp.note, runner.note].filter(Boolean).join("; ") } : {}
      };
    });
  }
  session(id, turn) {
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        turn: turn ?? "",
        touched: /* @__PURE__ */ new Set(),
        current: /* @__PURE__ */ new Set(),
        shown: /* @__PURE__ */ new Map(),
        baseline: /* @__PURE__ */ new Map(),
        hasBaseline: false
      };
      this.sessions.set(id, session);
    }
    if (turn && session.turn !== turn) {
      session.turn = turn;
      session.current.clear();
    }
    return session;
  }
  id(value) {
    if (typeof value === "string" && value) return value;
    if (this.sessions.size === 1) return this.sessions.keys().next().value ?? "manual";
    if (this.sessions.size > 1)
      throw new Error(
        "Multiple sessions: provide session from Hook feedback, or a new unique session for manual checks"
      );
    return "manual";
  }
  async check(paths, id, turn, lspOnly = false, signal = new AbortController().signal, offset = 0) {
    const snapshot = await inventory(this.root);
    const previous = this.previousSnapshot;
    if (previous?.version !== snapshot.version && this.language) {
      const configChanged = [.../* @__PURE__ */ new Set([...snapshot.files.keys(), ...previous?.files.keys() ?? []])].some(
        (path) => /(?:config|lock|manifest|Cargo\.toml|package\.json|go\.mod|pyproject)/i.test(path) && previous?.files.get(path) !== snapshot.files.get(path)
      );
      if (configChanged) {
        await this.language.close();
        this.language = void 0;
      } else await this.language.sync(snapshot.files);
    }
    this.previousSnapshot = snapshot;
    const session = this.session(id, turn);
    const results = [];
    const deadline = Date.now() + 45e3;
    for (const requested of [...new Set(paths)]) {
      signal.throwIfAborted();
      let path = requested;
      try {
        path = relative4(this.root, await workspacePath(this.root, requested));
      } catch (error) {
        results.push({ path, state: "skipped", findings: [], note: message(error) });
        this.cache.delete(path);
        session.touched.delete(path);
        continue;
      }
      session.touched.add(path);
      session.current.add(path);
      if (Date.now() >= deadline || results.length >= 200) {
        this.cache.delete(path);
        this.cache.delete(`lsp:${path}`);
        results.push({ path, state: "pending", findings: [], note: "Scan time budget reached" });
        continue;
      }
      const key = `${lspOnly ? "lsp:" : ""}${path}`;
      const cached = this.cache.get(key);
      const content = hash(await readFile5(await workspacePath(this.root, path), "utf8"));
      if (snapshot.complete && cached?.version === snapshot.version && cached.content === content && cached.result.state === "complete") {
        results.push(cached.result);
        continue;
      }
      const result = await this.checker(path, signal, lspOnly);
      if (hash(await readFile5(await workspacePath(this.root, path), "utf8")) !== content) {
        result.state = "stale";
        result.note = "File changed during diagnostics; retry";
      }
      this.cache.set(key, { version: snapshot.version, content, result });
      results.push(result);
    }
    const after = await inventory(this.root);
    if (!after.complete || after.version !== snapshot.version) {
      for (const result of results) {
        result.state = "stale";
        result.note = "Workspace changed or snapshot incomplete; retry";
      }
    }
    if (paths.length > 200 || !snapshot.complete)
      results.push({
        path: ".",
        state: "pending",
        findings: [],
        note: "File/snapshot budget exceeded; narrow paths"
      });
    return render(results, 50, 8192, offset);
  }
  async entries(mode, id) {
    const snapshot = await inventory(this.root);
    const session = this.session(id);
    const files = mode === "delta" ? session.current : session.touched;
    const results = [];
    for (const path of files) {
      const entry = this.cache.get(path) ?? this.cache.get(`lsp:${path}`);
      if (!entry) {
        results.push({ path, state: "pending", findings: [] });
        continue;
      }
      let content;
      try {
        content = hash(await readFile5(await workspacePath(this.root, path), "utf8"));
      } catch {
      }
      results.push(
        entry.version === snapshot.version && entry.content === content && snapshot.complete ? entry.result : { ...entry.result, state: "stale", note: "Workspace changed; run active diagnostics" }
      );
    }
    return results;
  }
  async cached(mode, id, offset = 0) {
    return render(await this.entries(mode, id), 50, 8192, offset);
  }
  async feedback(id) {
    const session = this.session(id);
    const changed = [];
    for (const result of await this.entries("all", id)) {
      if (result.state === "complete" && result.findings.length === 0) {
        session.shown.delete(result.path);
        continue;
      }
      if (result.state === "skipped" && result.note?.startsWith("No LSP server configured")) continue;
      const fingerprint = hash(JSON.stringify(result));
      if (session.shown.get(result.path) === fingerprint) continue;
      changed.push(result);
      session.shown.set(result.path, fingerprint);
    }
    return changed.length ? `session=${id}
${render(changed, 10, 1800)}
Details: check_diagnostics mode=all workspace=${this.root}` : "";
  }
  async hook(input, signal) {
    const id = text(input["session_id"], "hook");
    const session = this.session(id, text(input["turn_id"]));
    const snapshot = await inventory(this.root);
    const event = text(input["hook_event_name"], "PostToolUse");
    if (event === "SessionStart" || event === "PreToolUse") {
      if (!session.hasBaseline) {
        session.baseline = snapshot.files;
        session.hasBaseline = true;
      }
      return "";
    }
    if (event === "SessionEnd") {
      this.sessions.delete(id);
      return "";
    }
    if (!session.hasBaseline) {
      session.baseline = snapshot.files;
      session.hasBaseline = true;
      return "";
    }
    const changed = [...snapshot.files].filter(([path, version]) => session.baseline.get(path) !== version).map(([path]) => path);
    for (const path of session.baseline.keys())
      if (!snapshot.files.has(path)) {
        this.cache.delete(path);
        this.cache.delete(`lsp:${path}`);
        session.touched.delete(path);
        session.current.delete(path);
        session.shown.delete(path);
      }
    session.baseline = snapshot.files;
    const stopping = event === "Stop" || event === "SubagentStop";
    if (stopping && input["stop_hook_active"] === true) return "";
    const retry = stopping ? (await this.entries("all", id)).filter((entry) => entry.state === "pending" || entry.state === "stale").map((entry) => entry.path) : [];
    const paths = [.../* @__PURE__ */ new Set([...changed, ...retry])];
    if (paths.length) await this.check(paths, id, session.turn, false, signal);
    const output = await this.feedback(id);
    if (!output) return "";
    if (stopping) {
      const errors = (await this.entries("all", id)).some(
        (entry) => entry.state === "complete" && entry.findings.some((finding) => finding.severity === "error")
      );
      return JSON.stringify(errors ? { decision: "block", reason: output } : { systemMessage: output });
    }
    return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: output } });
  }
  dispatch(operation, args, signal) {
    const task = this.queue.then(() => {
      signal.throwIfAborted();
      return this.execute(operation, args, signal);
    });
    this.queue = task.catch(() => void 0);
    return task;
  }
  async paths(args, snapshot) {
    const values = Array.isArray(args["paths"]) ? args["paths"] : [text(args["path"], ".")];
    if (values.length > 200 || !values.every((value) => typeof value === "string"))
      throw new Error("paths must contain at most 200 strings");
    const paths = /* @__PURE__ */ new Set();
    for (const value of values) {
      if (typeof value !== "string") continue;
      const absolute = await workspacePath(this.root, value);
      const prefix = relative4(this.root, absolute);
      if ((await stat(absolute)).isFile()) paths.add(prefix);
      else
        for (const path of snapshot.files.keys())
          if (!prefix || path.startsWith(`${prefix}${sep3}`)) paths.add(path);
    }
    return [...paths];
  }
  async execute(operation, args, signal) {
    if (operation === "hook") return this.hook(args, signal);
    const mode = text(args["mode"], "delta");
    if (operation === "check_diagnostics" && mode === "status")
      return `workspace=${this.root}
sessions=${[...this.sessions.keys()].join(",") || "none"}
cache=${this.cache.size}`;
    const id = this.id(args["session"]);
    if (operation === "check_diagnostics" && (mode === "all" || mode === "delta"))
      return this.cached(mode, id, number(args["offset"], 0));
    if (operation === "lsp_navigation") {
      this.language ??= new Languages(this.root);
      const before = args["operation"] === "rename" ? await inventory(this.root) : void 0;
      const output2 = await this.language.navigate(args, signal);
      if (before) {
        this.cache.clear();
        const after = await inventory(this.root);
        const changed = [...after.files].filter(([path, version]) => before.files.get(path) !== version).map(([path]) => path);
        await this.check([.../* @__PURE__ */ new Set([text(args["path"]), ...changed])], id, "manual", false, signal);
      }
      return output2;
    }
    const snapshot = await inventory(this.root);
    const paths = await this.paths(args, snapshot);
    if (operation === "lsp_format") {
      if (!args["paths"] && !args["path"]) throw new Error("Explicit formatting paths required");
      if (paths.length > 200) throw new Error("Format at most 200 explicitly scoped files");
      this.language ??= new Languages(this.root);
      const lines = [];
      for (const path of paths)
        lines.push(await formatWithRunner(this.root, path, signal) ?? await this.language.format(path, signal));
      await this.check(paths, id, "manual", false, signal);
      return lines.join("\n").slice(0, 8e3) || "No files";
    }
    if (operation !== "lsp_diagnostics" && !(operation === "check_diagnostics" && mode === "full"))
      throw new Error("Unknown tool or mode");
    const start = number(args["start"], 0);
    const selected = paths.slice(start, start + 200);
    const output = await this.check(
      selected,
      id,
      "manual",
      operation === "lsp_diagnostics",
      signal,
      number(args["offset"], 0)
    );
    return `${output}${start + 200 < paths.length ? `
partial; next start=${start + 200}; remaining files=${paths.length - start - 200}` : ""}${!snapshot.complete ? "\npartial; inventory exceeded budget" : ""}`;
  }
  async close() {
    await this.language?.close();
  }
  async save(path) {
    await writeFile3(
      path,
      JSON.stringify({
        sessions: [...this.sessions].map(([id, session]) => [
          id,
          {
            turn: session.turn,
            hasBaseline: session.hasBaseline,
            touched: [...session.touched],
            baseline: [...session.baseline]
          }
        ])
      }),
      { mode: 384 }
    );
  }
  async restore(path) {
    try {
      const data = JSON.parse(await readFile5(path, "utf8"));
      if (!record(data) || !Array.isArray(data["sessions"])) return;
      for (const row of data["sessions"])
        if (Array.isArray(row) && typeof row[0] === "string" && record(row[1])) {
          const session = this.session(row[0], text(row[1]["turn"]));
          session.hasBaseline = row[1]["hasBaseline"] === true;
          const baseline = row[1]["baseline"];
          if (Array.isArray(baseline)) {
            for (const pair of baseline)
              if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string")
                session.baseline.set(pair[0], pair[1]);
          }
          const touched = row[1]["touched"];
          if (Array.isArray(touched)) {
            for (const value of touched) if (typeof value === "string") session.touched.add(value);
          }
        }
    } catch {
    }
  }
};

// src/worker.ts
async function identity(root) {
  const base = process.env["CODEX_LSP_CACHE"] ?? join10(tmpdir(), `codex-lsp-${process.getuid?.() ?? hash(homedir3()).slice(0, 10)}`);
  await mkdir(base, { recursive: true, mode: 448 });
  const stat2 = await lstat2(base);
  if (stat2.isSymbolicLink() || process.platform !== "win32" && ((stat2.mode & 63) !== 0 || stat2.uid !== process.getuid?.()))
    throw new Error("Unsafe worker cache permissions");
  let userConfig = "";
  try {
    userConfig = await readFile6(
      join10(process.env["CODEX_HOME"] ?? join10(homedir3(), ".codex"), "lsp-client.json"),
      "utf8"
    );
  } catch {
  }
  const script = fileURLToPath2(import.meta.url);
  const key = hash(
    JSON.stringify([
      root,
      hash(await readFile6(script, "utf8")),
      process.execPath,
      process.env["PATH"],
      process.env["CODEX_HOME"],
      process.env["CODEX_LSP_TRUST_PROJECT"],
      process.env["LSP_TOOLS_MCP_USER_CONFIG"],
      process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"],
      userConfig
    ])
  ).slice(0, 24);
  const dir = join10(base, key);
  await mkdir(dir, { mode: 448 }).catch((error) => {
    if (!record(error) || error["code"] !== "EEXIST") throw error;
  });
  if ((await lstat2(dir)).isSymbolicLink()) throw new Error("Unsafe cache directory");
  return { dir, socket: process.platform === "win32" ? `\\\\.\\pipe\\codex-lsp-${key}` : join10(dir, "worker.sock") };
}
async function address(dir, socket) {
  const token = await readFile6(join10(dir, "token"), "utf8");
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid worker token");
  return { dir, socket, token };
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function ensure(root) {
  const { dir, socket } = await identity(root);
  const lock = join10(dir, "lock");
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const pid = Number(await readFile6(join10(lock, "pid"), "utf8"));
      if (alive(pid) && await readFile6(join10(dir, "ready"), "utf8") === String(pid)) return address(dir, socket);
      if (!alive(pid)) {
        await rm(lock, { recursive: true, force: true });
        await rm(join10(dir, "ready"), { force: true });
      }
    } catch {
    }
    try {
      await mkdir(lock, { mode: 448 });
      await writeFile4(join10(lock, "pid"), String(process.pid));
      const token = randomBytes(32).toString("hex");
      await writeFile4(join10(dir, "token"), token, { mode: 384 });
      await rm(join10(dir, "ready"), { force: true });
      const child = spawn4(process.execPath, [fileURLToPath2(import.meta.url), "worker", root, dir, socket], {
        cwd: root,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env }
      });
      if (!child.pid) throw new Error("Worker failed to spawn");
      child.once("error", () => {
      });
      await writeFile4(join10(lock, "pid"), String(child.pid));
      child.unref();
    } catch (error) {
      if (!record(error) || error["code"] !== "EEXIST") throw error;
    }
    await new Promise((resolve6) => setTimeout(resolve6, 50));
  }
  throw new Error("Worker did not become ready within 5 seconds; inspect cache lock/process");
}
async function request(root, operation, args, signal) {
  if (!isAbsolute4(root)) throw new Error("workspace must be an absolute project directory");
  root = await realpath2(root);
  const target = await ensure(root);
  signal.throwIfAborted();
  return new Promise((resolve6, reject) => {
    const socket = createConnection(target.socket);
    let data = "";
    const cancel = () => socket.destroy(new Error("Request cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    socket.setTimeout(55e3, () => socket.destroy(new Error("Worker request timed out; diagnostics may be pending")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ token: target.token, operation, args })}
`));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) socket.destroy(new Error("Worker response too large"));
      if (!data.includes("\n")) return;
      try {
        const value = JSON.parse(data);
        if (!record(value) || typeof value["output"] !== "string")
          throw new Error(
            record(value) ? text(value["error"], "Invalid worker response") : "Invalid worker response"
          );
        resolve6(value["output"]);
      } catch (error) {
        reject(error);
      }
      socket.end();
    });
    socket.once("error", reject);
    socket.once("close", () => {
      signal.removeEventListener("abort", cancel);
      if (!data.includes("\n")) reject(new Error("Worker connection closed before response"));
    });
  });
}
async function runWorker(root, dir, socketPath) {
  const token = await readFile6(join10(dir, "token"), "utf8");
  if (!await trusted(root)) process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"] = join10(dir, "disabled-project-config");
  process.env["LSP_TOOLS_MCP_USER_CONFIG"] ??= join10(
    process.env["CODEX_HOME"] ?? join10(homedir3(), ".codex"),
    "lsp-client.json"
  );
  const engine = new Engine(root);
  const statePath = join10(dir, "state.json");
  await engine.restore(statePath);
  let active = 0;
  let lastUsed = Date.now();
  if (process.platform !== "win32") await rm(socketPath, { force: true });
  const server = createServer((socket) => {
    const controller = new AbortController();
    let buffer = "";
    let started = false;
    socket.setTimeout(6e4, () => socket.destroy());
    socket.once("close", () => controller.abort());
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (started) return;
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        socket.destroy();
        return;
      }
      if (!buffer.includes("\n")) return;
      started = true;
      const execute = async () => {
        let value;
        try {
          value = JSON.parse(buffer);
        } catch {
          throw new Error("Invalid worker JSON");
        }
        if (!record(value) || value["token"] !== token || !record(value["args"]))
          throw new Error("Unauthorized worker request");
        active++;
        try {
          return await engine.dispatch(text(value["operation"]), value["args"], controller.signal);
        } finally {
          active--;
          lastUsed = Date.now();
          await engine.save(statePath);
        }
      };
      void execute().then(
        (output) => socket.end(`${JSON.stringify({ output })}
`),
        (error) => socket.end(`${JSON.stringify({ error: message(error) })}
`)
      );
    });
  });
  await new Promise((resolve6, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve6);
  });
  await writeFile4(join10(dir, "ready"), String(process.pid));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    server.close();
    await engine.close();
    await engine.save(statePath);
    await rm(join10(dir, "ready"), { force: true });
    await rm(join10(dir, "lock"), { force: true, recursive: true });
    process.exit(0);
  };
  const timer = setInterval(() => {
    if (!active && Date.now() - lastUsed > 12e4) void close();
  }, 1e4);
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
}

// src/codex-hook.ts
async function runHookCli() {
  stdin.setEncoding("utf8");
  let raw = "";
  for await (const chunk of stdin) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error("Hook input too large");
  }
  if (!raw.trim()) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid Hook JSON");
  }
  if (!record(parsed)) throw new Error("Hook input must be an object");
  let root = await realpath3(text(parsed["cwd"], process.cwd()));
  try {
    const result = await promisify2(execFile2)("git", ["rev-parse", "--show-toplevel"], { cwd: root, timeout: 3e3 });
    root = await realpath3(result.stdout.trim());
  } catch {
  }
  try {
    const output = await request(root, "hook", parsed, new AbortController().signal);
    if (output) process.stdout.write(`${output}
`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ systemMessage: `Codex LSP unavailable: ${message(error).slice(0, 300)}` })}
`
    );
  }
}

// src/environment.ts
import { basename, dirname as dirname5 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
function restoreInstalledHome(script = fileURLToPath3(import.meta.url)) {
  if (process.env["CODEX_HOME"]) return;
  let child = dirname5(script);
  for (let parent = dirname5(child); parent !== child; parent = dirname5(child)) {
    if (basename(parent) === "plugins" && basename(child) === "cache") {
      process.env["CODEX_HOME"] = dirname5(parent);
      return;
    }
    child = parent;
  }
}

// src/protocol.ts
import { createInterface } from "node:readline";
var string = { type: "string" };
var scope = {
  workspace: { type: "string", description: "Absolute user repository path, never the plugin directory." },
  session: {
    type: "string",
    description: "Codex session id for cached/delta results; required when multiple sessions share this workspace."
  },
  path: string,
  paths: { type: "array", items: string, maxItems: 200 }
};
var paging = {
  offset: { type: "integer", minimum: 0, maximum: 1e4 },
  start: { type: "integer", minimum: 0, maximum: 1e4 }
};
function tool(name, description, properties, required, readOnly) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required: ["workspace", ...required], additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false }
  };
}
var TOOLS = [
  tool(
    "check_diagnostics",
    "LSP/lint state: delta=current turn, all=session touched cache, full=active bounded repository scan, status=runtime. Stale/partial is not clean. Use start/offset continuation when returned.",
    { ...scope, ...paging, mode: { type: "string", enum: ["delta", "all", "full", "status"] } },
    [],
    true
  ),
  tool(
    "lsp_diagnostics",
    "Actively check files/directories with LSP only. Defaults to workspace. Bounded multi-language scan; continue using returned start/offset.",
    { ...scope, ...paging },
    [],
    true
  ),
  tool(
    "lsp_navigation",
    "LSP definition/references/symbols/prepare_rename/rename. Positions are 1-based. Rename writes workspace files sequentially; prepare first.",
    {
      ...scope,
      operation: { type: "string", enum: ["definition", "references", "symbols", "prepare_rename", "rename"] },
      line: { type: "integer", minimum: 1 },
      column: { type: "integer", minimum: 1 },
      query: string,
      newName: string
    },
    ["path", "operation"],
    false
  ),
  tool(
    "lsp_format",
    "Explicitly format scoped files with the configured project formatter or LSP. Writes files, checks conflicts, then rechecks diagnostics. Never runs lint fix.",
    scope,
    [],
    false
  )
];
function validateArguments(name, args) {
  const definition = TOOLS.find((entry) => entry.name === name);
  if (!definition) throw new Error("Unknown tool");
  for (const key of definition.inputSchema.required) if (args[key] === void 0) throw new Error(`${key} required`);
  for (const [key, value] of Object.entries(args)) {
    const schema = definition.inputSchema.properties[key];
    if (!record(schema)) throw new Error(`Unknown argument: ${key}`);
    if (schema["type"] === "string" && typeof value !== "string") throw new Error(`${key} must be a string`);
    if (schema["type"] === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value) || typeof schema["minimum"] === "number" && value < schema["minimum"] || typeof schema["maximum"] === "number" && value > schema["maximum"])
        throw new Error(`Invalid integer: ${key}`);
    }
    if (schema["type"] === "array" && (!Array.isArray(value) || value.length > 200 || !value.every((item) => typeof item === "string")))
      throw new Error(`${key} must contain at most 200 strings`);
    if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) throw new Error(`Invalid ${key}`);
  }
}
async function runMcp(input = process.stdin, output = process.stdout) {
  const controllers = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Set();
  const send = (value) => output.write(`${JSON.stringify(value)}
`);
  const handle = async (value) => {
    if (!record(value)) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    const id = value["id"];
    const method = value["method"];
    const params = record(value["params"]) ? value["params"] : {};
    if (method === "notifications/cancelled") {
      const target = params["requestId"];
      if (typeof target === "string" || typeof target === "number") controllers.get(target)?.abort();
      return;
    }
    if (id === void 0) return;
    if (typeof id !== "string" && typeof id !== "number") {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid id" } });
      return;
    }
    const ok = (result) => send({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      ok({
        protocolVersion: text(params["protocolVersion"], "2024-11-05"),
        serverInfo: { name: "codex-lsp", version: "0.3.0" },
        // keep in sync with package.json
        capabilities: { tools: { listChanged: false } }
      });
      return;
    }
    if (method === "ping") {
      ok({});
      return;
    }
    if (method === "tools/list") {
      ok({ tools: TOOLS });
      return;
    }
    if (method === "resources/list") {
      ok({ resources: [] });
      return;
    }
    if (method === "resources/templates/list") {
      ok({ resourceTemplates: [] });
      return;
    }
    if (method !== "tools/call") {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (controllers.size >= 16 || controllers.has(id)) {
      send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Too many or duplicate requests" } });
      return;
    }
    const controller = new AbortController();
    controllers.set(id, controller);
    try {
      const name = text(params["name"]);
      if (!TOOLS.some((entry) => entry.name === name)) throw new Error("Unknown tool");
      if (!record(params["arguments"])) throw new Error("Tool arguments required");
      const args = params["arguments"];
      validateArguments(name, args);
      const result = await request(text(args["workspace"]), name, args, controller.signal);
      ok({ content: [{ type: "text", text: result }] });
    } catch (error) {
      ok({ isError: true, content: [{ type: "text", text: message(error).slice(0, 2e3) }] });
    } finally {
      controllers.delete(id);
    }
  };
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (line.length > 1024 * 1024) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } });
      continue;
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
      continue;
    }
    const task = handle(value);
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
}

// src/cli.ts
async function main() {
  restoreInstalledHome();
  const [command = "mcp", root, dir, socket] = process.argv.slice(2);
  if (command === "mcp") await runMcp();
  else if (command === "hook") await runHookCli();
  else if (command === "worker" && root && dir && socket) await runWorker(root, dir, socket);
  else throw new Error("Usage: codex-lsp [mcp | hook]");
}
main().catch((error) => {
  process.stderr.write(`${message(error)}
`);
  process.exitCode = 1;
});
