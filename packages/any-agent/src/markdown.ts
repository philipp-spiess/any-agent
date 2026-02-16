import { formatUsd } from "./pricing";
import type {
  UnifiedTranscript,
  MessageItem,
  AssistantToolMessage,
  ClaudeCodeBashTool,
  ClaudeCodeReadTool,
  ClaudeCodeEditTool,
  ClaudeCodeWriteTool,
  ClaudeCodeGlobTool,
  ClaudeCodeGrepTool,
  CodexShellTool,
  UnknownTool,
} from "./types";

function fence(language: string, content: string): string {
  const safe = content == null ? "" : String(content);
  // Ensure we don't prematurely close the fence
  const normalized = safe.replace(/```/g, "\u0060\u0060\u0060");
  return `\n\n\u0060\u0060\u0060${language}\n${normalized}\n\u0060\u0060\u0060\n\n`;
}

function renderHeader(t: UnifiedTranscript): string {
  const lines: string[] = [];
  const title =
    t.preview && t.preview.trim().length > 0 ? t.preview : "Conversation";
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`- **source**: ${t.source}`);
  lines.push(`- **model**: ${t.model}`);
  lines.push(
    `- **timestamp**: ${t.timestamp.toISOString?.() ?? String(t.timestamp)}`
  );
  lines.push(`- **when**: ${t.relativeTime}`);
  lines.push(`- **tokens**: ${t.blendedTokens.toLocaleString()}`);
  lines.push(`- **cost**: ${formatUsd(t.costUsd)}`);
  lines.push("");
  return lines.join("\n");
}

function renderUserMessage(text: string): string {
  return `\n**User**\n\n${text}\n`;
}

function renderAssistantText(text: string): string {
  return `\n**Assistant**\n\n${text}\n`;
}

function renderAssistantThinking(text: string): string {
  return `\n**Assistant (thinking)**${fence("text", text)}`;
}

function renderTool(toolMsg: AssistantToolMessage): string {
  const call = toolMsg.call;
  if ((call as CodexShellTool).tool === "CodexShell") {
    const shell = call as CodexShellTool;
    let out = `\n**Assistant (tool: shell)**${fence(
      "bash",
      `$ ${shell.command}`
    )}`;
    if (shell.output && shell.output.trim().length > 0) {
      out += fence("text", shell.output);
    }
    if (typeof shell.exit_code === "number") {
      out += `Exit code: ${shell.exit_code}\n\n`;
    }
    return out;
  }

  if ((call as ClaudeCodeBashTool).tool === "ClaudeCodeBash") {
    const bash = call as ClaudeCodeBashTool;
    let out = `\n**Assistant (tool: bash)**${fence(
      "bash",
      `$ ${bash.command}`
    )}`;
    if (bash.output && bash.output.trim().length > 0) {
      out += fence("text", bash.output);
    }
    return out;
  }

  if ((call as ClaudeCodeReadTool).tool === "ClaudeCodeRead") {
    const read = call as ClaudeCodeReadTool;
    let header = `Read file: ${read.file}`;
    if (read.lines) header += ` (lines: ${read.lines})`;
    return `\n**Assistant (tool: read)**\n\n${header}\n`;
  }

  if ((call as ClaudeCodeEditTool).tool === "ClaudeCodeEdit") {
    const edit = call as ClaudeCodeEditTool;
    let out = `\n**Assistant (tool: edit)**\n\nFile: ${edit.file}`;
    if (edit.diff) {
      out += fence("diff", edit.diff);
    }
    return out;
  }

  if ((call as ClaudeCodeWriteTool).tool === "ClaudeCodeWrite") {
    const write = call as ClaudeCodeWriteTool;
    let out = `\n**Assistant (tool: write)**\n\nFile: ${write.file}`;
    if (write.content && write.content.trim().length > 0) {
      out += fence("", write.content);
    }
    return out;
  }

  if ((call as ClaudeCodeGlobTool).tool === "ClaudeCodeGlob") {
    const glob = call as ClaudeCodeGlobTool;
    const results = (glob.results ?? []).join("\n");
    let out = `\n**Assistant (tool: glob)**\n\nPattern: ${glob.pattern}`;
    if (results) {
      out += fence("text", results);
    }
    return out;
  }

  if ((call as ClaudeCodeGrepTool).tool === "ClaudeCodeGrep") {
    const grep = call as ClaudeCodeGrepTool;
    let out = `\n**Assistant (tool: grep)**\n\nPattern: ${grep.pattern}`;
    if (grep.results && grep.results.trim().length > 0) {
      out += fence("text", grep.results);
    }
    return out;
  }

  if ((call as UnknownTool).tool === "Unknown") {
    const unk = call as UnknownTool;
    const details = JSON.stringify(unk, null, 2);
    return `\n**Assistant (tool: ${unk.name})**${fence("json", details)}`;
  }

  const fallback = JSON.stringify(call, null, 2);
  return `\n**Assistant (tool)**${fence("json", fallback)}`;
}

function renderMessage(msg: MessageItem): string {
  if (msg.role === "user") {
    return renderUserMessage(msg.text);
  }
  if (msg.role === "assistant" && "thinking" in msg) {
    return renderAssistantThinking(msg.thinking);
  }
  if (msg.role === "assistant" && "text" in msg) {
    return renderAssistantText(msg.text);
  }
  if (msg.role === "assistant" && "call" in msg) {
    return renderTool(msg as AssistantToolMessage);
  }
  return "";
}

export function transcriptToMarkdown(transcript: UnifiedTranscript): string {
  const parts: string[] = [];
  parts.push(renderHeader(transcript));
  parts.push("");
  parts.push("---");
  parts.push("");
  for (const msg of transcript.messages) {
    parts.push(renderMessage(msg));
  }
  return parts.join("\n").trim() + "\n";
}
