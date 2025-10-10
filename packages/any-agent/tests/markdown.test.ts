import { describe, it, expect } from "vitest";
import { transcriptToMarkdown } from "../src/markdown";
import type { UnifiedTranscript } from "../src/types";

describe("transcriptToMarkdown", () => {
  it("renders header and basic messages", () => {
    const t: UnifiedTranscript = {
      v: 1,
      id: "test-1",
      source: "codex",
      timestamp: new Date("2025-01-01T12:00:00Z"),
      relativeTime: "2 days ago",
      preview: "Fix bug in auth flow",
      model: "gpt-5-codex",
      blendedTokens: 1234,
      costUsd: 0.0123,
      messageCount: 3,
      branchMarker: " ",
      messages: [
        { role: "user", text: "Please fix the login bug." },
        { role: "assistant", text: "I will investigate the issue." },
      ],
    };

    const md = transcriptToMarkdown(t);
    expect(md).toContain("# Fix bug in auth flow");
    expect(md).toContain("**source**: codex");
    expect(md).toContain("**model**: gpt-5-codex");
    expect(md).toContain("**User**");
    expect(md).toContain("Please fix the login bug.");
    expect(md).toContain("**Assistant**");
    expect(md).toContain("I will investigate the issue.");
  });

  it("renders tool calls (CodexShell) with code fences", () => {
    const t: UnifiedTranscript = {
      v: 1,
      id: "test-2",
      source: "codex",
      timestamp: new Date("2025-01-02T12:00:00Z"),
      relativeTime: "yesterday",
      preview: "Investigate CI failure",
      model: "gpt-5-codex",
      blendedTokens: 100,
      costUsd: 0,
      messageCount: 2,
      branchMarker: " ",
      messages: [
        {
          role: "assistant",
          call: {
            tool: "CodexShell",
            command: "npm test",
            output: "All tests passed\n",
            exit_code: 0,
          },
        },
      ],
    };

    const md = transcriptToMarkdown(t);
    expect(md).toContain("tool: shell");
    expect(md).toContain("```bash");
    expect(md).toContain("$ npm test");
    expect(md).toContain("All tests passed");
    expect(md).toContain("Exit code: 0");
  });
});
