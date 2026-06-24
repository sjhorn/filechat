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
];

const SYSTEM =
  "You are a helpful assistant working with the user's files in a browser-based store. " +
  "Answer questions from the file contents, and cite file names when relevant. " +
  "When the user asks you to change a file, use the write_file or str_replace tools immediately — " +
  "do NOT just describe what you would change; call the tool right away. " +
  "Prefer str_replace for small targeted edits. After editing, briefly say what you changed. " +
  "Edits are applied to the user's local browser storage only.";

// --- simulated file store ---
const files = {};

function addFile(name, content) {
  files[name] = content;
}

function buildSystemWithFiles() {
  const ctx = Object.entries(files)
    .map(([k, v]) => `\n\n===== FILE: ${k} =====\n${v}`)
    .join("");
  return SYSTEM + (ctx ? "\n\nThe user's current files:" + ctx : "");
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
async function chat(messages, question) {
  const system = buildSystemWithFiles();
  messages.push({ role: "user", content: question });

  const MAX_TURNS = 6;
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

  // --- summary ---
  console.log("---");
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
