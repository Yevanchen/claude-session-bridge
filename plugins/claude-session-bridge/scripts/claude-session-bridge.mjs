#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const DEFAULT_CLAUDE_HOME = path.join(HOME, ".claude");
const OVERLAY_PATH = path.join(HOME, ".codex", "claude-session-bridge", "overlay.json");
const MAX_TEXT = 2_000;
const TERMINAL_STATUSES = new Set(["complete", "completed", "done", "failed", "stopped", "cancelled", "canceled", "error", "exited"]);
const WEB_TOKEN = randomUUID();

let webServerPromise = null;
let webBaseUrl = null;

const tools = [
  {
    name: "claude_bridge_view",
    description:
      "Start or return the local Claude Session Bridge web UI. The UI shows Working and Complete views and local terminal links.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["working", "complete", "all"], description: "Initial view. Defaults to working." }
      },
      additionalProperties: false
    }
  },
  {
    name: "claude_sessions_list",
    description:
      "List local Claude Code transcript sessions by scanning ~/.claude/projects. Reads transcript metadata only and applies Codex-side alias/archive overlay.",
    inputSchema: {
      type: "object",
      properties: {
        claudeHome: { type: "string", description: "Override Claude home directory. Defaults to ~/.claude." },
        limit: { type: "number", description: "Maximum sessions to return. Defaults to 25, max 200." },
        maxScan: { type: "number", description: "Maximum recent JSONL files to parse before filtering. Defaults to 100, max 1000." },
        cwdContains: { type: "string", description: "Optional substring filter for transcript cwd." },
        search: { type: "string", description: "Optional substring filter for title, alias, cwd, or session id." },
        includeArchived: { type: "boolean", description: "Include sessions archived in the Codex-side overlay." }
      },
      additionalProperties: false
    }
  },
  {
    name: "claude_session_read",
    description:
      "Read one Claude Code transcript's metadata and optionally a bounded message preview. Message content is returned only when includeMessages is true.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Claude session id, usually the JSONL filename stem." },
        transcriptPath: { type: "string", description: "Exact transcript path from claude_sessions_list." },
        includeMessages: { type: "boolean", description: "Return bounded user/assistant message preview. Defaults to false." },
        maxMessages: { type: "number", description: "Maximum messages when includeMessages is true. Defaults to 20, max 100." },
        claudeHome: { type: "string", description: "Override Claude home directory. Defaults to ~/.claude." }
      },
      additionalProperties: false
    }
  },
  {
    name: "claude_session_terminal_link",
    description:
      "Return a local http://127.0.0.1 terminal link for a Claude Code session. Clicking it opens macOS Terminal and runs claude --resume.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        cwd: { type: "string", description: "Working directory for the terminal command." },
        model: { type: "string", description: "Optional Claude model or alias, passed as --model." },
        name: { type: "string", description: "Optional display name, passed as --name." },
        prompt: { type: "string", description: "Optional prompt appended to the resume command." }
      },
      additionalProperties: false
    }
  },
  {
    name: "claude_session_set_alias",
    description:
      "Set or clear a Codex-side alias for a Claude Code session. This does not mutate Claude's JSONL transcript.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        alias: { type: "string", description: "Alias to store. Empty string clears the alias." }
      },
      additionalProperties: false
    }
  },
  {
    name: "claude_session_archive",
    description:
      "Archive a Claude Code session in the Codex-side overlay. This hides it from default bridge list results and does not mutate Claude files.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "claude_session_unarchive",
    description: "Remove a Claude Code session from the Codex-side archive overlay.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "claude_background_agents_list",
    description:
      "List Claude Code background agents using `claude agents --json`. This is the supported CLI surface for active/background sessions.",
    inputSchema: {
      type: "object",
      properties: {
        includeCompleted: { type: "boolean", description: "Pass --all to include completed sessions." },
        cwd: { type: "string", description: "Optional --cwd filter." }
      },
      additionalProperties: false
    }
  },
  {
    name: "claude_session_resume_background",
    description:
      "Prepare or launch a Claude Code background resume command. Defaults to dryRun=true to avoid accidental spend or background work.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        prompt: { type: "string", description: "Optional prompt to send to the resumed background session." },
        model: { type: "string", description: "Optional Claude model or alias, passed as --model." },
        name: { type: "string", description: "Optional display name, passed as --name." },
        cwd: { type: "string", description: "Working directory for the Claude CLI process." },
        dryRun: { type: "boolean", description: "When true, only returns the command. Defaults to true." }
      },
      additionalProperties: false
    }
  },
  {
    name: "claude_session_start_background",
    description:
      "Prepare or launch a fresh Claude Code background session. Defaults to dryRun=true to avoid accidental spend or background work.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "Prompt to send to the new background session." },
        model: { type: "string", description: "Optional Claude model or alias, passed as --model." },
        name: { type: "string", description: "Optional display name, passed as --name." },
        cwd: { type: "string", description: "Working directory for the Claude CLI process." },
        dryRun: { type: "boolean", description: "When true, only returns the command. Defaults to true." }
      },
      additionalProperties: false
    }
  },
  {
    name: "claude_cli_info",
    description: "Report the installed Claude CLI path and version visible to this plugin process.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }
];

async function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
      await handleRequest(request);
    } catch (error) {
      const id = request?.id ?? null;
      write({ jsonrpc: "2.0", id, error: { code: -32603, message: String(error?.message ?? error) } });
    }
  }
}

async function handleRequest(request) {
  const { id, method, params } = request;
  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "claude-session-bridge", version: "0.1.0" }
      }
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") {
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    write({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const result = await callTool(name, args);
    write({ jsonrpc: "2.0", id, result: asToolResult(result) });
    return;
  }
  write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
}

async function callTool(name, args) {
  const baseUrl = await ensureWebServer();
  let result;
  switch (name) {
    case "claude_bridge_view":
      return { uiUrl: viewUrl(baseUrl, args.view), terminalSupport: terminalSupportInfo() };
    case "claude_sessions_list":
      result = await listSessions(args, baseUrl);
      break;
    case "claude_session_read":
      result = await readSession(args, baseUrl);
      break;
    case "claude_session_terminal_link":
      result = terminalLinkResult(args, baseUrl);
      break;
    case "claude_session_set_alias":
      result = await updateOverlay(args.sessionId, { alias: args.alias ?? "" });
      break;
    case "claude_session_archive":
      result = await updateOverlay(args.sessionId, { archived: true });
      break;
    case "claude_session_unarchive":
      result = await updateOverlay(args.sessionId, { archived: false });
      break;
    case "claude_background_agents_list":
      result = listBackgroundAgents(args, baseUrl);
      break;
    case "claude_session_resume_background":
      result = resumeBackground(args, baseUrl);
      break;
    case "claude_session_start_background":
      result = startBackground(args, baseUrl);
      break;
    case "claude_cli_info":
      result = claudeCliInfo();
      break;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
  return withUiUrl(result, baseUrl);
}

async function listSessions(args, baseUrl) {
  const limit = clampNumber(args.limit, 25, 1, 200);
  const overlay = await readOverlay();
  const sessions = await scanSessions(args.claudeHome, args.maxScan);
  const search = normalizeSearch(args.search);
  const cwdContains = normalizeSearch(args.cwdContains);

  const filtered = sessions
    .map((session) => addSessionLinks(applyOverlay(session, overlay), baseUrl))
    .filter((session) => args.includeArchived || !session.archived)
    .filter((session) => !cwdContains || session.cwd.toLowerCase().includes(cwdContains))
    .filter((session) => {
      if (!search) return true;
      return [session.sessionId, session.title, session.alias, session.cwd, session.transcriptPath]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search));
    })
    .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
    .slice(0, limit);

  return {
    count: filtered.length,
    uiUrl: viewUrl(baseUrl, "all"),
    claudeHome: path.resolve(args.claudeHome || DEFAULT_CLAUDE_HOME),
    overlayPath: OVERLAY_PATH,
    sessions: filtered
  };
}

async function readSession(args, baseUrl) {
  const transcriptPath = args.transcriptPath || (await findTranscriptPath(args.sessionId, args.claudeHome));
  if (!transcriptPath) throw new Error("Provide sessionId or transcriptPath");
  const parsed = await parseTranscript(transcriptPath, {
    includeMessages: Boolean(args.includeMessages),
    maxMessages: clampNumber(args.maxMessages, 20, 1, 100)
  });
  const overlay = await readOverlay();
  return {
    uiUrl: viewUrl(baseUrl, "all", { sessionId: parsed.sessionId }),
    session: addSessionLinks(applyOverlay(parsed, overlay), baseUrl)
  };
}

async function updateOverlay(sessionId, patch) {
  if (!sessionId || typeof sessionId !== "string") throw new Error("sessionId is required");
  const overlay = await readOverlay();
  overlay.sessions ??= {};
  overlay.sessions[sessionId] ??= {};
  if (Object.hasOwn(patch, "alias")) {
    const alias = String(patch.alias ?? "").trim();
    if (alias) overlay.sessions[sessionId].alias = alias;
    else delete overlay.sessions[sessionId].alias;
  }
  if (Object.hasOwn(patch, "archived")) {
    overlay.sessions[sessionId].archived = Boolean(patch.archived);
  }
  overlay.updatedAt = new Date().toISOString();
  await writeOverlay(overlay);
  return { sessionId, overlay: overlay.sessions[sessionId], overlayPath: OVERLAY_PATH };
}

function listBackgroundAgents(args, baseUrl) {
  const cli = spawnSync("claude", ["agents", "--json", ...(args.includeCompleted ? ["--all"] : []), ...(args.cwd ? ["--cwd", args.cwd] : [])], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  if (cli.error) throw cli.error;
  if (cli.status !== 0) {
    throw new Error((cli.stderr || cli.stdout || `claude agents exited ${cli.status}`).trim());
  }
  const agents = dedupeAgents(JSON.parse(cli.stdout || "[]")).map((agent) => addAgentLinks(agent, baseUrl));
  return {
    uiUrl: viewUrl(baseUrl, "working"),
    agents
  };
}

function resumeBackground(args, baseUrl) {
  if (!args.sessionId || typeof args.sessionId !== "string") throw new Error("sessionId is required");
  const commandArgs = backgroundCommandArgs({ ...args, sessionId: args.sessionId });
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : process.cwd();
  const dryRun = args.dryRun !== false;
  const terminalUrl = terminalResumeUrl(baseUrl, {
    sessionId: args.sessionId,
    cwd,
    model: args.model,
    name: args.name,
    prompt: args.prompt
  });
  if (dryRun) {
    return { dryRun: true, uiUrl: viewUrl(baseUrl, "working"), terminalUrl, cwd, command: ["claude", ...commandArgs] };
  }
  const child = spawn("claude", commandArgs, { cwd, stdio: "ignore", detached: true });
  child.unref();
  return { dryRun: false, uiUrl: viewUrl(baseUrl, "working"), terminalUrl, cwd, pid: child.pid, command: ["claude", ...commandArgs] };
}

function startBackground(args, baseUrl) {
  if (!args.prompt || typeof args.prompt !== "string") throw new Error("prompt is required");
  const commandArgs = backgroundCommandArgs(args);
  const cwd = args.cwd ? path.resolve(String(args.cwd)) : process.cwd();
  const dryRun = args.dryRun !== false;
  const terminalUrl = terminalStartUrl(baseUrl, {
    cwd,
    model: args.model,
    name: args.name,
    prompt: args.prompt
  });
  if (dryRun) {
    return { dryRun: true, uiUrl: viewUrl(baseUrl, "working"), terminalUrl, cwd, command: ["claude", ...commandArgs] };
  }
  const child = spawn("claude", commandArgs, { cwd, stdio: "ignore", detached: true });
  child.unref();
  return { dryRun: false, uiUrl: viewUrl(baseUrl, "working"), terminalUrl, cwd, pid: child.pid, command: ["claude", ...commandArgs] };
}

function backgroundCommandArgs(args) {
  const commandArgs = ["--bg"];
  if (args.sessionId) commandArgs.push("--resume", String(args.sessionId));
  if (args.model) commandArgs.push("--model", String(args.model));
  if (args.name) commandArgs.push("--name", String(args.name));
  if (args.prompt) commandArgs.push(String(args.prompt));
  return commandArgs;
}

function claudeCliInfo() {
  const which = spawnSync("command", ["-v", "claude"], { shell: true, encoding: "utf8" });
  const version = spawnSync("claude", ["--version"], { encoding: "utf8" });
  return {
    path: which.stdout.trim() || null,
    version: version.stdout.trim() || version.stderr.trim() || null,
    versionExitCode: version.status
  };
}

async function ensureWebServer() {
  if (webBaseUrl) return webBaseUrl;
  if (webServerPromise) return webServerPromise;
  webServerPromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handleHttpRequest(req, res).catch((error) => {
        sendJson(res, 500, { error: String(error?.message ?? error) });
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      webBaseUrl = `http://127.0.0.1:${address.port}`;
      server.unref();
      resolve(webBaseUrl);
    });
  });
  return webServerPromise;
}

async function handleHttpRequest(req, res) {
  const url = new URL(req.url || "/", webBaseUrl || "http://127.0.0.1");
  if (url.pathname === "/" || url.pathname === "/view") {
    sendHtml(res, 200, renderHtml(url.searchParams.get("view") || "working"));
    return;
  }
  if (url.pathname === "/api/items") {
    sendJson(
      res,
      200,
      await buildViewData(url.searchParams.get("view") || "working", {
        sessionId: url.searchParams.get("sessionId") || ""
      })
    );
    return;
  }
  if (url.pathname === "/terminal/resume") {
    await handleTerminalResume(url, res);
    return;
  }
  if (url.pathname === "/terminal/start") {
    await handleTerminalStart(url, res);
    return;
  }
  sendHtml(res, 404, "<!doctype html><title>Not found</title><p>Not found</p>");
}

async function handleTerminalResume(url, res) {
  if (url.searchParams.get("token") !== WEB_TOKEN) {
    sendHtml(res, 403, "<!doctype html><title>Forbidden</title><p>Forbidden</p>");
    return;
  }
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    sendHtml(res, 400, "<!doctype html><title>Missing session</title><p>Missing sessionId</p>");
    return;
  }
  const cwd = url.searchParams.get("cwd") || HOME;
  const args = ["claude", "--resume", sessionId];
  const model = url.searchParams.get("model");
  const name = url.searchParams.get("name");
  const prompt = url.searchParams.get("prompt");
  if (model) args.push("--model", model);
  if (name) args.push("--name", name);
  if (prompt) args.push(prompt);
  const command = `cd ${shellQuote(cwd)} && ${args.map(shellQuote).join(" ")}`;
  const opened = openTerminal(command);
  sendHtml(
    res,
    opened.ok ? 200 : 500,
    renderTerminalResult({ ok: opened.ok, command, message: opened.message })
  );
}

async function handleTerminalStart(url, res) {
  if (url.searchParams.get("token") !== WEB_TOKEN) {
    sendHtml(res, 403, "<!doctype html><title>Forbidden</title><p>Forbidden</p>");
    return;
  }
  const prompt = url.searchParams.get("prompt");
  if (!prompt) {
    sendHtml(res, 400, "<!doctype html><title>Missing prompt</title><p>Missing prompt</p>");
    return;
  }
  const cwd = url.searchParams.get("cwd") || HOME;
  const args = backgroundCommandArgs({
    model: url.searchParams.get("model"),
    name: url.searchParams.get("name"),
    prompt
  });
  const command = `cd ${shellQuote(cwd)} && ${["claude", ...args].map(shellQuote).join(" ")}`;
  const opened = openTerminal(command);
  sendHtml(
    res,
    opened.ok ? 200 : 500,
    renderTerminalResult({ ok: opened.ok, command, message: opened.message })
  );
}

function openTerminal(command) {
  if (process.platform !== "darwin") {
    return { ok: false, message: "Terminal launch is currently implemented for macOS only." };
  }
  const script = [
    'tell application "Terminal"',
    `do script ${appleScriptString(command)}`,
    "activate",
    "end tell"
  ];
  const result = spawnSync("osascript", script.flatMap((line) => ["-e", line]), { encoding: "utf8" });
  if (result.error) return { ok: false, message: result.error.message };
  if (result.status !== 0) return { ok: false, message: (result.stderr || result.stdout || "osascript failed").trim() };
  return { ok: true, message: "Terminal opened." };
}

async function buildViewData(viewInput, options = {}) {
  const view = normalizedView(viewInput);
  const sessionFilter = normalizeSearch(options.sessionId);
  const overlay = await readOverlay();
  const sessions = (await scanSessions(undefined, 100))
    .map((session) => addSessionLinks(applyOverlay(session, overlay), webBaseUrl))
    .filter((session) => !session.archived);
  const agents = dedupeAgents(readBackgroundAgents({ includeCompleted: true }))
    .map((agent) => addAgentLinks(agent, webBaseUrl));
  const agentSessionIds = new Set(agents.map((agent) => agent.sessionId).filter(Boolean));
  const agentItems = agents.map((agent) => ({
    id: agent.sessionId || `agent:${agent.pid || agent.name || randomUUID()}`,
    kind: "background-agent",
    state: agentState(agent),
    title: agent.name || agent.sessionId || "Claude background agent",
    cwd: agent.cwd || "",
    status: agent.status || "",
    updatedAt: agent.startedAt || null,
    terminalUrl: agent.terminalUrl,
    source: agent
  }));
  const transcriptItems = sessions
    .filter((session) => !agentSessionIds.has(session.sessionId))
    .map((session) => ({
      id: session.sessionId,
      kind: "transcript",
      state: "complete",
      title: session.alias || session.title || session.sessionId,
      cwd: session.cwd,
      status: "complete",
      updatedAt: session.updatedAt || session.modifiedAt,
      terminalUrl: session.terminalUrl,
      source: session
    }));
  const filteredItems = [...agentItems, ...transcriptItems].filter((item) => {
    if (!sessionFilter) return true;
    return String(item.id || "").toLowerCase() === sessionFilter;
  });
  const allItems = filteredItems
    .filter((item) => view === "all" || item.state === view)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return {
    view,
    sessionId: options.sessionId || null,
    generatedAt: new Date().toISOString(),
    counts: {
      working: filteredItems.filter((item) => item.state === "working").length,
      complete: filteredItems.filter((item) => item.state === "complete").length,
      all: filteredItems.length
    },
    items: allItems
  };
}

function readBackgroundAgents(args = {}) {
  const cli = spawnSync("claude", ["agents", "--json", ...(args.includeCompleted ? ["--all"] : []), ...(args.cwd ? ["--cwd", args.cwd] : [])], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  if (cli.error) throw cli.error;
  if (cli.status !== 0) {
    throw new Error((cli.stderr || cli.stdout || `claude agents exited ${cli.status}`).trim());
  }
  return JSON.parse(cli.stdout || "[]");
}

function renderHtml(initialView) {
  const view = normalizedView(initialView);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Session Bridge</title>
<style>
:root { color-scheme: light; --bg:#f7f7f4; --panel:#ffffff; --ink:#1f2328; --muted:#667085; --line:#d8d9d2; --work:#0f766e; --done:#5850ec; --accent:#7c3aed; }
* { box-sizing: border-box; }
body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--ink); }
header { height:64px; display:flex; align-items:center; justify-content:space-between; padding:0 24px; border-bottom:1px solid var(--line); background:#fbfbf8; }
h1 { margin:0; font-size:18px; font-weight:650; letter-spacing:0; }
.meta { color:var(--muted); font-size:12px; }
main { max-width:1120px; margin:0 auto; padding:20px 18px 32px; }
.toolbar { display:flex; gap:10px; align-items:center; justify-content:space-between; margin-bottom:14px; flex-wrap:wrap; }
.tabs { display:flex; gap:4px; padding:3px; border:1px solid var(--line); background:#eeeeea; border-radius:8px; }
.tab { border:0; background:transparent; color:var(--muted); padding:8px 12px; border-radius:6px; font:inherit; font-size:13px; cursor:pointer; }
.tab.active { background:var(--panel); color:var(--ink); box-shadow:0 1px 2px rgba(0,0,0,.08); }
.search { min-width:260px; height:36px; border:1px solid var(--line); border-radius:6px; padding:0 10px; background:white; font:inherit; }
.list { border:1px solid var(--line); background:var(--panel); border-radius:8px; overflow:hidden; }
.row { display:grid; grid-template-columns: 104px 1fr 170px 116px; gap:14px; align-items:center; padding:13px 14px; border-bottom:1px solid #ecece7; min-height:68px; }
.row:last-child { border-bottom:0; }
.badge { display:inline-flex; align-items:center; gap:7px; font-size:12px; font-weight:650; text-transform:uppercase; letter-spacing:.04em; }
.dot { width:8px; height:8px; border-radius:50%; background:var(--done); }
.working .dot { background:var(--work); }
.title { min-width:0; }
.title strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; }
.title span { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); font-size:12px; margin-top:4px; }
.time { color:var(--muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.actions { display:flex; justify-content:flex-end; gap:8px; }
.iconbtn { width:36px; height:32px; display:inline-grid; place-items:center; border:1px solid var(--line); border-radius:6px; background:#fff; color:var(--ink); text-decoration:none; font-size:15px; }
.empty { padding:36px 16px; text-align:center; color:var(--muted); }
@media (max-width: 760px) {
  header { padding:0 14px; }
  main { padding:14px 10px 24px; }
  .row { grid-template-columns: 1fr 86px; gap:8px; }
  .badge, .time { display:none; }
  .search { width:100%; min-width:0; }
}
</style>
</head>
<body>
<header><h1>Claude Session Bridge</h1><div class="meta" id="updated">Loading</div></header>
<main>
  <div class="toolbar">
    <div class="tabs">
      <button class="tab" data-view="working">Working <span id="count-working"></span></button>
      <button class="tab" data-view="complete">Complete <span id="count-complete"></span></button>
      <button class="tab" data-view="all">All <span id="count-all"></span></button>
    </div>
    <input class="search" id="search" placeholder="Filter sessions" autocomplete="off">
  </div>
  <section class="list" id="list"></section>
</main>
<script>
let currentView = ${JSON.stringify(view)};
let currentItems = [];
const params = new URLSearchParams(window.location.search);
const sessionId = params.get("sessionId") || "";
const list = document.getElementById("list");
const search = document.getElementById("search");
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => load(tab.dataset.view));
}
search.addEventListener("input", render);
async function load(view) {
  currentView = view;
  const apiParams = new URLSearchParams({ view });
  if (sessionId) apiParams.set("sessionId", sessionId);
  const viewParams = new URLSearchParams(apiParams);
  history.replaceState(null, "", "/view?" + viewParams.toString());
  const response = await fetch("/api/items?" + apiParams.toString(), { cache: "no-store" });
  const data = await response.json();
  currentItems = data.items || [];
  document.getElementById("updated").textContent = new Date(data.generatedAt).toLocaleString();
  for (const name of ["working", "complete", "all"]) {
    document.querySelector('[data-view="' + name + '"]').classList.toggle("active", name === data.view);
    document.getElementById("count-" + name).textContent = data.counts?.[name] ?? "";
  }
  render();
}
function render() {
  const query = search.value.trim().toLowerCase();
  const rows = currentItems.filter(item => !query || [item.title, item.cwd, item.status, item.id].join(" ").toLowerCase().includes(query));
  if (!rows.length) {
    list.innerHTML = '<div class="empty">No sessions</div>';
    return;
  }
  list.innerHTML = rows.map(item => {
    const state = escapeHtml(item.state);
    const title = escapeHtml(item.title || item.id);
    const cwd = escapeHtml(item.cwd || "");
    const status = escapeHtml(item.status || item.kind);
    const time = escapeHtml(item.updatedAt || "");
    const terminal = item.terminalUrl ? '<a class="iconbtn" title="Open Terminal" href="' + escapeAttr(item.terminalUrl) + '">T</a>' : "";
    return '<article class="row ' + state + '"><div class="badge"><i class="dot"></i>' + state + '</div><div class="title"><strong>' + title + '</strong><span>' + cwd + '</span></div><div class="time">' + time + '</div><div class="actions">' + terminal + '</div></article>';
  }).join("");
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
}
function escapeAttr(value) { return escapeHtml(value); }
load(currentView);
</script>
</body>
</html>`;
}

function renderTerminalResult({ ok, command, message }) {
  return `<!doctype html><meta charset="utf-8"><title>Claude Terminal</title><style>body{font-family:ui-sans-serif,system-ui;margin:32px;background:#f7f7f4;color:#1f2328}code{display:block;white-space:pre-wrap;background:#fff;border:1px solid #d8d9d2;border-radius:8px;padding:12px}</style><h1>${ok ? "Terminal opened" : "Terminal not opened"}</h1><p>${escapeHtml(message)}</p><code>${escapeHtml(command)}</code>`;
}

function sendHtml(res, status, body) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body, null, 2));
}

async function scanSessions(claudeHome, maxScanInput) {
  const projectsRoot = path.join(path.resolve(claudeHome || DEFAULT_CLAUDE_HOME), "projects");
  const maxScan = clampNumber(maxScanInput, 100, 1, 1000);
  const files = (await collectJsonl(projectsRoot))
    .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
    .slice(0, maxScan);
  const sessions = [];
  for (const file of files) {
    try {
      const session = await parseTranscript(file.path, { includeMessages: false, maxMessages: 0 });
      if (isSessionTranscript(session)) sessions.push(session);
    } catch {
      // Ignore malformed or concurrently-written transcripts.
    }
  }
  return dedupeSessions(sessions);
}

async function collectJsonl(root) {
  const out = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = await fs.stat(full);
          out.push({ path: full, modifiedAtMs: stat.mtimeMs });
        } catch {
          // Ignore files that disappear during scanning.
        }
      }
    }
  }
  await visit(root);
  return out;
}

async function parseTranscript(transcriptPath, options) {
  const stat = await fs.stat(transcriptPath);
  const raw = await fs.readFile(transcriptPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const sessionIdFromFile = path.basename(transcriptPath, ".jsonl");
  const typeCounts = {};
  const messages = [];
  let sessionId = sessionIdFromFile;
  let cwd = "";
  let title = "";
  let firstUserMessage = "";
  let latestTimestamp = null;
  let createdTimestamp = null;

  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.sessionId) sessionId = String(record.sessionId);
    if (!cwd && typeof record.cwd === "string") cwd = record.cwd;
    if (record.type) typeCounts[record.type] = (typeCounts[record.type] ?? 0) + 1;
    if (record.type === "custom-title" && typeof record.customTitle === "string") title = record.customTitle.trim() || title;
    if (record.type === "ai-title" && typeof record.aiTitle === "string" && !title) title = record.aiTitle.trim();
    const timestamp = parseTimestamp(record.timestamp);
    if (timestamp) {
      latestTimestamp = !latestTimestamp || timestamp > latestTimestamp ? timestamp : latestTimestamp;
      createdTimestamp = !createdTimestamp || timestamp < createdTimestamp ? timestamp : createdTimestamp;
    }
    const message = extractMessage(record);
    if (!message) continue;
    if (!firstUserMessage && message.role === "user") firstUserMessage = summarize(message.text);
    if (!title && message.role === "user") title = summarize(message.text);
    if (options.includeMessages && messages.length < options.maxMessages) messages.push(message);
  }

  return {
    sessionId,
    transcriptPath,
    transcriptHash: createHash("sha256").update(raw).digest("hex"),
    cwd,
    title,
    firstUserMessage,
    createdAt: createdTimestamp?.toISOString() ?? null,
    updatedAt: latestTimestamp?.toISOString() ?? null,
    modifiedAt: new Date(stat.mtimeMs).toISOString(),
    modifiedAtMs: stat.mtimeMs,
    bytes: stat.size,
    lineCount: lines.length,
    typeCounts,
    ...(options.includeMessages ? { messages } : {})
  };
}

function extractMessage(record) {
  if (record.type !== "user" && record.type !== "assistant") return null;
  if (record.isMeta === true || record.isSidechain === true) return null;
  const role = record.type === "assistant" ? "assistant" : "user";
  const content = record.message?.content ?? record.content;
  const text = extractContentText(content);
  if (!text.trim()) return null;
  return {
    role,
    timestamp: record.timestamp ?? null,
    text: truncate(text.trim(), MAX_TEXT)
  };
}

function extractContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      parts.push(`[tool_use: ${block.name || "unknown"}]`);
    } else if (block.type === "tool_result") {
      parts.push("[tool_result]");
    }
  }
  return parts.join("\n\n");
}

async function findTranscriptPath(sessionId, claudeHome) {
  if (!sessionId) return null;
  const projectsRoot = path.join(path.resolve(claudeHome || DEFAULT_CLAUDE_HOME), "projects");
  const files = await collectJsonl(projectsRoot);
  const byName = files.find((file) => path.basename(file.path, ".jsonl") === sessionId);
  if (byName) return byName.path;
  for (const file of files.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)) {
    try {
      const parsed = await parseTranscript(file.path, { includeMessages: false, maxMessages: 0 });
      if (parsed.sessionId === sessionId) return file.path;
    } catch {
      // Ignore malformed or concurrently-written transcripts.
    }
  }
  return null;
}

async function readOverlay() {
  try {
    return JSON.parse(await fs.readFile(OVERLAY_PATH, "utf8"));
  } catch {
    return { version: 1, sessions: {} };
  }
}

async function writeOverlay(overlay) {
  await fs.mkdir(path.dirname(OVERLAY_PATH), { recursive: true });
  await fs.writeFile(OVERLAY_PATH, `${JSON.stringify(overlay, null, 2)}\n`);
}

function applyOverlay(session, overlay) {
  const state = overlay.sessions?.[session.sessionId] ?? {};
  return {
    ...session,
    alias: state.alias ?? null,
    archived: Boolean(state.archived)
  };
}

function isSessionTranscript(session) {
  if (!session || !session.sessionId) return false;
  const basename = path.basename(session.transcriptPath || "", ".jsonl");
  if (basename === "journal" && session.sessionId === "journal") return false;
  return Boolean(
    session.typeCounts?.user ||
      session.typeCounts?.assistant ||
      session.cwd ||
      session.title ||
      session.firstUserMessage
  );
}

function dedupeSessions(sessions) {
  const bySessionId = new Map();
  for (const session of sessions) {
    const existing = bySessionId.get(session.sessionId);
    if (!existing || Number(session.modifiedAtMs || 0) > Number(existing.modifiedAtMs || 0)) {
      bySessionId.set(session.sessionId, session);
    }
  }
  return [...bySessionId.values()];
}

function dedupeAgents(agents) {
  const bySession = new Map();
  for (const agent of agents) {
    const key = agent.sessionId || agent.id || `agent:${agent.pid || agent.name || randomUUID()}`;
    const existing = bySession.get(key);
    if (!existing || shouldPreferAgent(agent, existing)) bySession.set(key, agent);
  }
  return [...bySession.values()];
}

function shouldPreferAgent(candidate, current) {
  const candidateState = agentState(candidate);
  const currentState = agentState(current);
  if (candidateState !== currentState) return candidateState === "working";
  return Number(candidate.startedAt || 0) >= Number(current.startedAt || 0);
}

function withUiUrl(value, baseUrl) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { uiUrl: viewUrl(baseUrl, "working"), value };
  }
  return { uiUrl: viewUrl(baseUrl, "working"), ...value };
}

function addSessionLinks(session, baseUrl) {
  return {
    ...session,
    uiUrl: viewUrl(baseUrl, "all"),
    terminalUrl: terminalResumeUrl(baseUrl, {
      sessionId: session.sessionId,
      cwd: session.cwd
    })
  };
}

function addAgentLinks(agent, baseUrl) {
  return {
    ...agent,
    state: agentState(agent),
    terminalUrl: agent.sessionId
      ? terminalResumeUrl(baseUrl, {
          sessionId: agent.sessionId,
          cwd: agent.cwd
        })
      : null
  };
}

function terminalLinkResult(args, baseUrl) {
  if (!args.sessionId || typeof args.sessionId !== "string") throw new Error("sessionId is required");
  const terminalUrl = terminalResumeUrl(baseUrl, {
    sessionId: args.sessionId,
    cwd: args.cwd,
    model: args.model,
    name: args.name,
    prompt: args.prompt
  });
  return {
    uiUrl: viewUrl(baseUrl, "all", { sessionId: args.sessionId }),
    terminalUrl,
    terminalSupport: terminalSupportInfo()
  };
}

function terminalResumeUrl(baseUrl, params) {
  const url = new URL("/terminal/resume", baseUrl);
  url.searchParams.set("token", WEB_TOKEN);
  url.searchParams.set("sessionId", params.sessionId);
  if (params.cwd) url.searchParams.set("cwd", params.cwd);
  if (params.model) url.searchParams.set("model", params.model);
  if (params.name) url.searchParams.set("name", params.name);
  if (params.prompt) url.searchParams.set("prompt", params.prompt);
  return url.toString();
}

function terminalStartUrl(baseUrl, params) {
  const url = new URL("/terminal/start", baseUrl);
  url.searchParams.set("token", WEB_TOKEN);
  if (params.cwd) url.searchParams.set("cwd", params.cwd);
  if (params.model) url.searchParams.set("model", params.model);
  if (params.name) url.searchParams.set("name", params.name);
  if (params.prompt) url.searchParams.set("prompt", params.prompt);
  return url.toString();
}

function viewUrl(baseUrl, view, params = {}) {
  const url = new URL("/view", baseUrl);
  url.searchParams.set("view", normalizedView(view));
  if (params.sessionId) url.searchParams.set("sessionId", params.sessionId);
  return url.toString();
}

function normalizedView(view) {
  return view === "complete" || view === "all" ? view : "working";
}

function agentState(agent) {
  const status = String(agent.status || agent.state || "").trim().toLowerCase();
  return TERMINAL_STATUSES.has(status) ? "complete" : "working";
}

function terminalSupportInfo() {
  return {
    platform: process.platform,
    opensTerminal: process.platform === "darwin",
    note: process.platform === "darwin" ? "Clicking terminalUrl opens macOS Terminal." : "Terminal launch is currently implemented for macOS only."
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function asToolResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function parseTimestamp(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function summarize(text) {
  return truncate(String(text).replace(/\s+/g, " ").trim(), 120);
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function normalizeSearch(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "";
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});

export const __filename = fileURLToPath(import.meta.url);
