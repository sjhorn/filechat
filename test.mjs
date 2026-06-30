/**
 * Integration test for filechat's API conversation flow.
 *
 * Tests: file context → query → tool-use edit → tool result → follow-up.
 * Mirrors the exact API contract used by index.html.
 *
 * Usage: node test.mjs
 * Requires: .env with API_TOKEN and API_BASE
 */

import { readFileSync } from "fs";

// load .env
const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const API_TOKEN = env.API_TOKEN;
const API_URL = env.API_BASE.replace(/\/$/, "") + "/v1/messages";

if (!API_TOKEN) {
  console.error("ERROR: API_TOKEN not set in .env");
  process.exit(1);
}

const TOOLS = [
  {
    name: "write_file",
    description: "Create or overwrite a file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "str_replace",
    description:
      "Replace an exact substring in a file. old_str must appear exactly once.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_str: { type: "string" },
        new_str: { type: "string" },
      },
      required: ["path", "old_str", "new_str"],
    },
  },
  {
    name: "list_files",
    description: "List all files in the store with sizes and line counts.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "read_file",
    description: "Read a file's contents (or a range of lines).",
    input_schema: {
      type: "object",
      properties: {
        path:   { type: "string" },
        offset: { type: "integer", description: "1-based starting line (default 1)" },
        limit:  { type: "integer", description: "Max lines to return (default 200)" },
      },
      required: ["path"],
    },
  },
  {
    name: "grep_files",
    description: "Search file contents for a pattern. Returns matching lines with context.",
    input_schema: {
      type: "object",
      properties: {
        pattern:       { type: "string" },
        path:          { type: "string" },
        context_lines: { type: "integer" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "head_file",
    description: "Read the first N lines of a file.",
    input_schema: {
      type: "object",
      properties: {
        path:  { type: "string" },
        lines: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "propose_plan",
    description: "Present a plan to the user before making changes. Call this BEFORE any write_file or str_replace when the task involves editing files.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        steps: { type: "array", items: { type: "string" } },
        files_affected: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "steps"],
    },
  },
  {
    name: "web_search",
    description: "Search the web for current information. Only the search query is sent externally.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
];

const SYSTEM_INLINE =
  "You are a helpful assistant working with the user's files in a browser-based store. " +
  "Answer questions from the file contents, and cite file names when relevant. " +
  "When the user asks you to change a file, use the write_file or str_replace tools immediately — " +
  "do NOT just describe what you would change; call the tool right away. " +
  "Prefer str_replace for small targeted edits. After editing, briefly say what you changed. " +
  "Edits are applied to the user's local browser storage only.";

const SYSTEM_AGENTIC =
  "You are a helpful assistant working with the user's files in a browser-based store. " +
  "File contents are NOT pre-loaded — treat the file store as external memory and query it on demand.\n\n" +
  "Workflow:\n" +
  "1. Use list_files to see what's available (like ls).\n" +
  "2. Use grep_files to find relevant sections — search first, read second.\n" +
  "3. Use read_file or head_file to read specific line ranges — only what you need.\n" +
  "4. To edit: grep/read to locate the target, then str_replace for surgical edits or write_file for full rewrites.\n\n" +
  "Keep your working context lean — read only what's relevant to the question. " +
  "Cite file names and line numbers when discussing content. " +
  "Edits are applied to the user's local browser storage only.";

// --- simulated file store ---
const files = {};
const INLINE_THRESHOLD = 12_000;

function addFile(name, content) {
  files[name] = content;
}

function clearFiles() {
  for (const k of Object.keys(files)) delete files[k];
}

const PLAN_AUTO = "\n\nWhen the user's request involves creating or editing files, call propose_plan first "
  + "to present your approach before making changes. For simple questions about file contents, "
  + "answer directly without a plan.";

const PLAN_ON = "\n\nIMPORTANT — PLAN MODE IS ACTIVE. Before making ANY edits, you MUST:\n"
  + "1. Investigate using read-only tools (list_files, read_file, grep_files, head_file).\n"
  + "2. Call propose_plan with your summary, steps, and affected files.\n"
  + "3. Wait for the user to approve before calling write_file or str_replace.\n"
  + "Do NOT skip the propose_plan step. Do NOT call write tools before your plan is approved.";

function buildSystemWithFiles(mode = "auto") {
  const entries = Object.entries(files);
  const totalChars = entries.reduce((sum, [, v]) => sum + v.length, 0);
  const useInline = totalChars > 0 && totalChars <= INLINE_THRESHOLD;
  const planSuffix = mode === "on" ? PLAN_ON : mode === "auto" ? PLAN_AUTO : "";

  if (useInline) {
    const ctx = entries
      .map(([k, v]) => `\n\n===== FILE: ${k} =====\n${v}`)
      .join("");
    return SYSTEM_INLINE + planSuffix + (ctx ? "\n\nThe user's current files:" + ctx : "");
  }

  if (entries.length) {
    let listing = "\n\nFiles in store (use read_file / grep_files to access contents):";
    for (const [k, v] of entries) {
      const lines = v.split("\n").length;
      listing += `\n- ${k} (${v.length.toLocaleString()} chars, ${lines.toLocaleString()} lines)`;
    }
    return SYSTEM_AGENTIC + planSuffix + listing;
  }

  return SYSTEM_INLINE + planSuffix + "\n\n(No files loaded.)";
}

function executeToolCall(name, input) {
  if (name === "write_file") {
    files[input.path] = input.content;
    return `Success: ${input.path} now has ${input.content.length} characters.`;
  }
  if (name === "str_replace") {
    const before = files[input.path];
    if (before == null) return `Error: no such file: ${input.path}`;
    const parts = before.split(input.old_str);
    if (parts.length === 1)
      return `Error: old_str not found in ${input.path}`;
    if (parts.length > 2)
      return `Error: old_str is not unique in ${input.path}`;
    files[input.path] = before.replace(input.old_str, input.new_str);
    return `Success: ${input.path} now has ${files[input.path].length} characters.`;
  }
  if (name === "list_files") {
    const listing = Object.entries(files).map(([k, v]) => ({
      name: k, size_chars: v.length, lines: v.split("\n").length,
    }));
    return JSON.stringify(listing, null, 2);
  }
  if (name === "read_file") {
    const text = files[input.path];
    if (text == null) return `Error: no such file: ${input.path}`;
    const allLines = text.split("\n");
    const offset = Math.max(1, input.offset || 1);
    const limit = Math.min(input.limit || 200, 2000);
    const start = offset - 1;
    const slice = allLines.slice(start, start + limit);
    const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(5)} | ${l}`).join("\n");
    return numbered + `\n\n(lines ${offset}-${Math.min(offset + slice.length - 1, allLines.length)} of ${allLines.length})`;
  }
  if (name === "head_file") {
    const text = files[input.path];
    if (text == null) return `Error: no such file: ${input.path}`;
    const n = Math.min(input.lines || 50, 500);
    const allLines = text.split("\n");
    const slice = allLines.slice(0, n);
    const numbered = slice.map((l, i) => `${String(i + 1).padStart(5)} | ${l}`).join("\n");
    return numbered + `\n\n(first ${slice.length} of ${allLines.length} lines)`;
  }
  if (name === "grep_files") {
    let re;
    try { re = new RegExp(input.pattern, "ig"); }
    catch (e) { return `Error: invalid pattern: ${e.message}`; }
    const ctx = Math.min(input.context_lines ?? 2, 5);
    const targetKeys = input.path ? [input.path] : Object.keys(files);
    const output = [];
    let matchCount = 0;
    for (const k of targetKeys) {
      const text = files[k];
      if (!text) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && matchCount < 50; i++) {
        if (re.test(lines[i])) {
          re.lastIndex = 0;
          matchCount++;
          const from = Math.max(0, i - ctx);
          const to = Math.min(lines.length - 1, i + ctx);
          for (let j = from; j <= to; j++) {
            output.push(`${k}:${j + 1}:${j === i ? ">" : " "} ${lines[j]}`);
          }
          output.push("---");
        }
      }
    }
    if (!matchCount) return `No matches found for "${input.pattern}"`;
    return output.join("\n");
  }
  if (name === "propose_plan") {
    // auto-approve plans in tests
    return "Plan approved. Execute the changes now.";
  }
  if (name === "web_search") {
    // mock search results in tests
    return `Summary: Mock search result for "${input.query}"\nSource: https://example.com\n\nRelated:\n- Result 1 for ${input.query}\n- Result 2 for ${input.query}`;
  }
  return `Error: unknown tool: ${name}`;
}

// --- API call ---
async function callAPI(system, messages) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + API_TOKEN,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system,
      tools: TOOLS,
      messages,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// --- agentic loop (mirrors index.html) ---
async function chat(messages, question, mode = "auto") {
  const system = buildSystemWithFiles(mode);
  messages.push({ role: "user", content: question });

  const MAX_TURNS = 15;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const data = await callAPI(system, messages);
    messages.push({ role: "assistant", content: data.content });

    const textOut = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const toolCalls = (data.content || []).filter(
      (b) => b.type === "tool_use"
    );

    if (data.stop_reason !== "tool_use" || !toolCalls.length) {
      return { text: textOut, toolCalls: [], messages };
    }

    // execute tools
    const results = [];
    const executed = [];
    for (const call of toolCalls) {
      const result = executeToolCall(call.name, call.input);
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: result,
      });
      executed.push({ name: call.name, input: call.input, result });
    }
    messages.push({ role: "user", content: results });

    // if this is the last turn with tools, get the follow-up text
    if (turn === MAX_TURNS - 1) {
      return { text: textOut, toolCalls: executed, messages };
    }
  }
}

// --- test helpers ---
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

// --- tests ---
async function main() {
  console.log("filechat integration test\n");
  console.log(`API: ${API_URL}\n`);

  // --- Test 1: Upload file and query it ---
  console.log("TEST 1: Upload file and query content");
  addFile(
    "notes.md",
    "# Project Alpha\n\nDeadline: March 2027\nBudget: $500k\nLead: Jane Smith\n"
  );

  const conversation = [];
  const r1 = await chat(
    conversation,
    "What is the deadline and budget for Project Alpha?"
  );

  assert(r1.text.length > 0, "got a text response");
  assert(
    /march\s*2027/i.test(r1.text),
    "response mentions March 2027 deadline"
  );
  assert(/500/i.test(r1.text), "response mentions $500k budget");
  console.log(`  Response: ${r1.text.slice(0, 120)}...\n`);

  // --- Test 2: Ask Claude to edit the file via tool use ---
  console.log("TEST 2: Request file edit via str_replace");
  const r2 = await chat(
    conversation,
    'Change the deadline in notes.md to "June 2027"'
  );

  // check the file was actually modified
  const updatedContent = files["notes.md"];
  assert(
    updatedContent && /June 2027/i.test(updatedContent),
    "file was updated with new deadline"
  );
  assert(
    updatedContent && !/March 2027/i.test(updatedContent),
    "old deadline was replaced"
  );
  console.log(`  Updated file: ${updatedContent.trim()}\n`);

  // --- Test 3: Verify conversation continuity ---
  console.log("TEST 3: Conversation continuity (follow-up question)");
  const r3 = await chat(conversation, "What is the deadline now?");

  assert(r3.text.length > 0, "got a follow-up response");
  assert(
    /june\s*2027/i.test(r3.text),
    "follow-up reflects updated deadline"
  );
  console.log(`  Response: ${r3.text.slice(0, 120)}...\n`);

  // --- Test 4: Verify conversation history is well-formed ---
  console.log("TEST 4: Conversation structure validation");
  let lastRole = null;
  let wellFormed = true;
  for (const msg of conversation) {
    if (msg.role === lastRole && msg.role === "assistant") {
      wellFormed = false;
      break;
    }
    // check tool_use has matching tool_result
    if (msg.role === "assistant") {
      const toolUses = (
        Array.isArray(msg.content) ? msg.content : [msg.content]
      ).filter((b) => b.type === "tool_use");
      if (toolUses.length > 0) {
        const nextMsg = conversation[conversation.indexOf(msg) + 1];
        if (
          !nextMsg ||
          nextMsg.role !== "user" ||
          !Array.isArray(nextMsg.content) ||
          nextMsg.content[0]?.type !== "tool_result"
        ) {
          wellFormed = false;
          break;
        }
      }
    }
    lastRole = msg.role;
  }
  assert(wellFormed, "conversation alternates roles correctly");
  assert(
    conversation[conversation.length - 1].role === "assistant",
    "conversation ends with assistant response"
  );
  console.log(`  Total messages: ${conversation.length}\n`);

  // --- Test 5: Large file — agentic grep + read workflow ---
  console.log("TEST 5: Large file (~150k) — agent uses grep/read tools");
  clearFiles();

  // generate a ~150k file with a needle buried in the middle
  {
    const filler = [];
    for (let i = 1; i <= 3000; i++) filler.push(`line ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.`);
    filler[1500] = "line 1501: IMPORTANT: The secret project codename is FALCON-9.";
    filler[1501] = "line 1502: FALCON-9 budget is $2.5 million, lead engineer is Alice.";
    addFile("large-report.txt", filler.join("\n"));

    const conv5 = [];
    const r5 = await chat(conv5, "What is the secret project codename in large-report.txt?");
    assert(r5.text.length > 0, "got a response for large file query");
    assert(/FALCON.?9/i.test(r5.text), "found the codename FALCON-9 in 150k file");

    // verify the agent used read-only tools (not just text from inline)
    const toolsUsed = [];
    for (const msg of conv5) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const b of msg.content) {
        if (b.type === "tool_use") toolsUsed.push(b.name);
      }
    }
    assert(
      toolsUsed.some(t => ["grep_files", "read_file", "head_file", "list_files"].includes(t)),
      `agent used read tools (tools used: ${toolsUsed.join(", ")})`
    );
    console.log(`  Tools used: ${toolsUsed.join(" → ")}`);
    console.log(`  Response: ${r5.text.slice(0, 150)}...\n`);
  }

  // --- Test 6: Large file — agentic edit workflow ---
  console.log("TEST 6: Large file (~150k) — agent edits via grep + str_replace");
  {
    const conv6 = [];
    const r6 = await chat(conv6, 'In large-report.txt, change the FALCON-9 budget from "$2.5 million" to "$3.8 million".');

    const updated = files["large-report.txt"];
    assert(updated && /\$3\.8 million/i.test(updated), "budget updated to $3.8 million");
    assert(updated && !/\$2\.5 million/i.test(updated), "old budget replaced");

    const toolsUsed = [];
    for (const msg of conv6) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const b of msg.content) {
        if (b.type === "tool_use") toolsUsed.push(b.name);
      }
    }
    assert(
      toolsUsed.includes("str_replace"),
      `agent used str_replace to edit (tools: ${toolsUsed.join(", ")})`
    );
    console.log(`  Tools used: ${toolsUsed.join(" → ")}`);
    console.log(`  Response: ${r6.text.slice(0, 150)}...\n`);
  }

  // --- Test 7: Very large file (~1M) — agent can still find content ---
  console.log("TEST 7: Very large file (~1M) — grep finds needle in haystack");
  clearFiles();
  {
    const filler = [];
    for (let i = 1; i <= 20000; i++) filler.push(`row ${i}: data_value=${Math.random().toFixed(6)} status=normal category=general`);
    filler[15000] = "row 15001: data_value=0.999999 status=CRITICAL category=security alert_code=RED-ALPHA-7";
    addFile("big-dataset.csv", filler.join("\n"));

    const conv7 = [];
    const r7 = await chat(conv7, "Find the CRITICAL status row in big-dataset.csv. What is the alert_code?");
    assert(r7.text.length > 0, "got a response for 1M file query");
    assert(/RED.?ALPHA.?7/i.test(r7.text), "found alert_code RED-ALPHA-7 in 1M file");
    console.log(`  Response: ${r7.text.slice(0, 150)}...\n`);
  }

  // --- Test 8: Multiple large files — grep across files ---
  console.log("TEST 8: Multiple large files — grep across files");
  clearFiles();
  {
    const filler1 = [];
    for (let i = 1; i <= 5000; i++) filler1.push(`module-a line ${i}: processing data`);
    filler1[2500] = "module-a line 2501: ERROR: database connection timeout after 30s";
    addFile("module-a.log", filler1.join("\n"));

    const filler2 = [];
    for (let i = 1; i <= 5000; i++) filler2.push(`module-b line ${i}: processing data`);
    filler2[4000] = "module-b line 4001: ERROR: disk space critically low at 2%";
    addFile("module-b.log", filler2.join("\n"));

    const conv8 = [];
    const r8 = await chat(conv8, "Find all ERROR lines across the log files. What errors occurred?");
    assert(r8.text.length > 0, "got a response for multi-file query");
    assert(/timeout/i.test(r8.text) || /connection/i.test(r8.text), "found database timeout error");
    assert(/disk/i.test(r8.text) || /space/i.test(r8.text), "found disk space error");
    console.log(`  Response: ${r8.text.slice(0, 200)}...\n`);
  }

  // --- Test 9: Plan mode "on" — agent must propose_plan before editing ---
  console.log("TEST 9: Plan mode on — agent proposes plan before editing (large file)");
  clearFiles();
  {
    const filler = [];
    for (let i = 1; i <= 3000; i++) filler.push(`line ${i}: server config parameter${i}=value${i}`);
    filler[500] = "line 501: server config max_connections=100";
    addFile("server.conf", filler.join("\n"));

    const conv9 = [];
    const r9 = await chat(conv9, 'Change max_connections from 100 to 200 in server.conf.', "on");

    // check agent used propose_plan
    const toolsUsed = [];
    for (const msg of conv9) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const b of msg.content) {
        if (b.type === "tool_use") toolsUsed.push(b.name);
      }
    }
    assert(toolsUsed.includes("propose_plan"), `agent called propose_plan (tools: ${toolsUsed.join(", ")})`);
    assert(toolsUsed.includes("str_replace"), `agent called str_replace after plan (tools: ${toolsUsed.join(", ")})`);

    // verify propose_plan came before str_replace
    const planIdx = toolsUsed.indexOf("propose_plan");
    const editIdx = toolsUsed.indexOf("str_replace") !== -1 ? toolsUsed.indexOf("str_replace") : toolsUsed.indexOf("write_file");
    assert(planIdx < editIdx, "propose_plan was called before write tool");

    // verify the edit was applied
    const updated = files["server.conf"];
    assert(updated && /max_connections=200/.test(updated), "max_connections updated to 200");
    console.log(`  Tools used: ${toolsUsed.join(" → ")}`);
    console.log(`  Response: ${r9.text.slice(0, 150)}...\n`);
  }

  // --- Test 10: Plan mode "auto" — simple question skips plan ---
  console.log("TEST 10: Plan mode auto — simple question answered directly");
  clearFiles();
  {
    addFile("readme.txt", "Project: Widget Factory\nVersion: 2.4.1\nAuthor: Bob\n");

    const conv10 = [];
    const r10 = await chat(conv10, "What version is the Widget Factory project?", "auto");
    assert(r10.text.length > 0, "got a text response");
    assert(/2\.4\.1/.test(r10.text), "response includes version 2.4.1");

    // check that propose_plan was NOT called (simple question)
    const toolsUsed = [];
    for (const msg of conv10) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const b of msg.content) {
        if (b.type === "tool_use") toolsUsed.push(b.name);
      }
    }
    assert(!toolsUsed.includes("propose_plan"), `no propose_plan for simple question (tools: ${toolsUsed.join(", ") || "none"})`);
    console.log(`  Tools used: ${toolsUsed.join(" → ") || "(none)"}`);
    console.log(`  Response: ${r10.text.slice(0, 150)}...\n`);
  }

  // --- Test 11: Plan mode "off" — edit without plan ---
  console.log("TEST 11: Plan mode off — direct edit without plan");
  clearFiles();
  {
    addFile("config.yml", "database:\n  host: localhost\n  port: 3306\n");

    const conv11 = [];
    const r11 = await chat(conv11, 'Change the database port to 5432 in config.yml.', "off");

    const toolsUsed = [];
    for (const msg of conv11) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const b of msg.content) {
        if (b.type === "tool_use") toolsUsed.push(b.name);
      }
    }
    assert(!toolsUsed.includes("propose_plan"), `no propose_plan in off mode (tools: ${toolsUsed.join(", ")})`);
    assert(toolsUsed.includes("str_replace") || toolsUsed.includes("write_file"), `used write tool directly (tools: ${toolsUsed.join(", ")})`);

    const updated = files["config.yml"];
    assert(updated && /5432/.test(updated), "port updated to 5432");
    console.log(`  Tools used: ${toolsUsed.join(" → ")}`);
    console.log(`  Response: ${r11.text.slice(0, 150)}...\n`);
  }

  // --- summary ---
  console.log("---");
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
