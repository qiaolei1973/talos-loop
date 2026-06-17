import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";

// The formatter is a standalone CommonJS script the launcher runs as
// `node <path>`; load it via createRequire so this ESM test can exercise its
// exports directly (seam D — the one new seam introduced by issue #30).
const require = createRequire(import.meta.url);
const { renderEvent, processStream } = require("../stream-formatter.cjs") as {
  renderEvent: (obj: unknown) => string[];
  processStream: (input: NodeJS.ReadableStream, output: { write: (s: string) => boolean }, sessionFile: string | null) => Promise<void>;
};

describe("renderEvent (issue #30, seam D)", () => {
  it("renders thinking / text / tool_use blocks from an assistant message", () => {
    const event = {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "我应该先读文件" },
          { type: "text", text: "正在处理" },
          { type: "tool_use", name: "Edit", input: { file: "a.ts" } },
        ],
      },
    };
    expect(renderEvent(event)).toEqual([
      "【思考】",
      "我应该先读文件",
      "正在处理",
      "【工具】 Edit",
      '参数: {"file":"a.ts"}',
    ]);
  });

  it("skips system / thinking_tokens / result / user events (keep the pane quiet)", () => {
    expect(renderEvent({ type: "system", subtype: "init", session_id: "x" })).toEqual([]);
    expect(renderEvent({ type: "system", subtype: "thinking_tokens", estimated_tokens: 5 })).toEqual([]);
    expect(renderEvent({ type: "result", is_error: false })).toEqual([]);
    expect(renderEvent({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } })).toEqual([]);
  });

  it("tolerates a content block missing expected fields", () => {
    // No crash. A text block with no `text` contributes nothing; a tool_use with
    // no `name` falls back to "(tool)" and an empty param object.
    expect(renderEvent({ type: "assistant", message: { content: [{ type: "text" }, { type: "tool_use" }] } })).toEqual([
      "【工具】 (tool)",
      "参数: {}",
    ]);
  });
});

describe("processStream (issue #30, seam D)", () => {
  const sidecar = path.join(os.tmpdir(), `tl-fmt-test-${process.pid}.txt`);

  function feed(lines: string[]): NodeJS.ReadableStream {
    return Readable.from(lines.map((l) => l + "\n"));
  }

  it("captures the init session id into the sidecar, renders content, and echoes non-JSON lines", async () => {
    try { fs.unlinkSync(sidecar); } catch { /* absent */ }
    const lines = [
      `{"type":"system","subtype":"init","session_id":"abc-123","tools":[]}`,
      `this is a non-JSON stderr warning (echoed verbatim)`,
      `{"type":"system","subtype":"thinking_tokens","estimated_tokens":1}`,
      `{"type":"assistant","message":{"content":[{"type":"text","text":"hello world"}]}}`,
      `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"cmd":"ls"}}]}}`,
    ];
    const out: string[] = [];
    await processStream(feed(lines), { write: (s) => { out.push(s); return true; } }, sidecar);

    // The session id was written to the sidecar from the FIRST init event.
    expect(fs.readFileSync(sidecar, "utf-8")).toBe("abc-123");
    // Rendered content reaches the pane…
    const joined = out.join("");
    expect(joined).toContain("hello world");
    expect(joined).toContain("【工具】 Bash");
    expect(joined).toContain('参数: {"cmd":"ls"}');
    // …non-JSON is echoed verbatim (tolerance, no abort)…
    expect(joined).toContain("this is a non-JSON stderr warning (echoed verbatim)");
    // …and the noisy thinking_tokens line is NOT echoed (it parses → rendered as nothing).
    expect(joined).not.toContain("estimated_tokens");
  });

  it("only writes the sidecar once even if multiple init events appear", async () => {
    try { fs.unlinkSync(sidecar); } catch { /* absent */ }
    const lines = [
      `{"type":"system","subtype":"init","session_id":"first-id"}`,
      `{"type":"system","subtype":"init","session_id":"second-id"}`,
    ];
    await processStream(feed(lines), { write: () => true }, sidecar);
    expect(fs.readFileSync(sidecar, "utf-8")).toBe("first-id");
  });

  it("does not throw on a non-JSON line, and skips the sidecar write when none given", async () => {
    try { fs.unlinkSync(sidecar); } catch { /* absent */ }
    const out: string[] = [];
    await expect(
      processStream(feed(["totally { broken", `{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}`]), { write: (s) => { out.push(s); return true; } }, sidecar),
    ).resolves.toBeUndefined();
    // No init → no sidecar.
    expect(fs.existsSync(sidecar)).toBe(false);
    // The broken line was tolerated, the valid event still rendered.
    expect(out.join("")).toContain("totally { broken");
    expect(out.join("")).toContain("ok");
  });
});
