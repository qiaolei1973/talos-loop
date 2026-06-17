"use strict";
/**
 * Claude Code stream-json formatter (issue #30).
 *
 * The launcher pipes claude's `--output-format=stream-json --verbose` output
 * through this script so an operator who `tmux attach`es sees a readable,
 * structured trace (thinking / tool calls / text) instead of raw JSON — and so a
 * failed session's pane retains that trace for forensics. The raw `.jsonl` is
 * still teed off by the launcher; this script only renders to stdout.
 *
 * It has a second, equally important job: the FIRST `init` event carries claude's
 * `-p` session id. The script writes that id to a sidecar file (path in
 * `TL_SESSION_FILE`) the moment it appears — early in the run, before completion —
 * so the dispatcher can persist it and an operator can `claude -r <id>` to resume
 * even a crashed session.
 *
 * Design constraints (see PRD issue #30):
 *   - Pure presentation + a tiny "dumb producer" sidecar write. It NEVER touches
 *     the database — the server stays the sole DB writer; the dispatcher reads the
 *     sidecar and persists.
 *   - Tolerant: claude occasionally emits non-JSON lines on stderr (warnings,
 *     progress). Those are echoed verbatim, never abort the stream.
 *   - Self-contained CommonJS (no imports), so the launcher can run it directly as
 *     `node <path>` in both dev (tsx) and compiled (dist) mode — it is copied to
 *     dist verbatim by the build.
 *
 * Exports `renderEvent` (pure) and `processStream` for unit tests (seam D).
 */

const fs = require("fs");
const readline = require("readline");

/**
 * Render a parsed stream-json event object into human-readable lines.
 *
 * @returns {string[]} lines to print (possibly empty — e.g. for the noisy
 *   `thinking_tokens` events, or `result`/`init` which we keep quiet). Pure: no
 *   I/O, so it is trivially unit-testable.
 */
function renderEvent(obj) {
  if (!obj || typeof obj !== "object") return [];

  // The first system event: `{"type":"system","subtype":"init",...}`. We render
  // nothing (it's metadata), but the caller captures its session_id — see
  // processStream. The `thinking_tokens` stream is per-token progress noise; skip.
  if (obj.type === "system") return [];

  // Assistant turn: a message whose `content` is an array of blocks
  // (thinking / text / tool_use). Mirror the reference jq mapping.
  if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
    const out = [];
    for (const block of obj.message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "thinking" && typeof block.thinking === "string") {
        out.push("【思考】");
        out.push(block.thinking);
      } else if (block.type === "text" && typeof block.text === "string") {
        out.push(block.text);
      } else if (block.type === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "(tool)";
        let params = "";
        try {
          params = JSON.stringify(block.input ?? {});
        } catch {
          params = "{}";
        }
        out.push(`【工具】 ${name}`);
        out.push(`参数: ${params}`);
      }
      // tool_result / unknown blocks are out of scope (PRD) — skip silently.
    }
    return out;
  }

  // `user` turns carry tool_result blocks (PRD: tool_result rendering is out of
  // scope) and the final `result` event carries totals — keep both quiet.
  return [];
}

/**
 * Walk a stream-json input, rendering each event to `output` and writing the
 * session id (from the first `init` event) to `sessionFile` once. Non-JSON lines
 * are echoed verbatim (tolerant of claude's stderr warnings). Never throws on a
 * bad line.
 *
 * @param input  a readable stream (the teed claude output)
 * @param output a writable stream (the tmux pane)
 * @param sessionFile absolute path to the session-id sidecar, or null to skip
 */
async function processStream(input, output, sessionFile) {
  let wroteSession = false;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line === "") continue; // skip blank lines between events
    let obj = null;
    try {
      obj = JSON.parse(line);
    } catch {
      // Non-JSON (e.g. a stderr warning merged in via 2>&1) — echo verbatim so the
      // operator still sees it and the stream is not interrupted.
      output.write(line + "\n");
      continue;
    }

    // Capture the session id from the first init event, the moment it appears.
    if (!wroteSession && obj && obj.type === "system" && obj.subtype === "init" && obj.session_id) {
      wroteSession = true;
      if (sessionFile) {
        try {
          fs.writeFileSync(sessionFile, String(obj.session_id), "utf-8");
        } catch {
          // best-effort: a missing id only costs resume-ability, never correctness
        }
      }
    }

    for (const rendered of renderEvent(obj)) {
      output.write(rendered + "\n");
    }
  }
}

if (require.main === module) {
  const sessionFile = process.env.TL_SESSION_FILE || null;
  processStream(process.stdin, process.stdout, sessionFile).catch(() => {
    // Swallow: a formatter crash must not be visible as a claude failure. The
    // launcher keys the exit sentinel off claude's own exit (PIPESTATUS[0]).
    process.exit(0);
  });
}

module.exports = { renderEvent, processStream };
