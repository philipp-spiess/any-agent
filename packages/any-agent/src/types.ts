import { z } from 'zod'

/**
 * Unified transcript format that can represent both Claude Code and Codex sessions
 * for rendering in a common UI
 */

// Claude Code tool call schemas
const ClaudeCodeReadToolSchema = z.object({
  tool: z.literal('ClaudeCodeRead'),
  file: z.string(),
  lines: z.string().optional(),
})

const ClaudeCodeEditToolSchema = z.object({
  tool: z.literal('ClaudeCodeEdit'),
  file: z.string(),
  diff: z.string(),
})

const ClaudeCodeWriteToolSchema = z.object({
  tool: z.literal('ClaudeCodeWrite'),
  file: z.string(),
  content: z.string().optional(),
})

const ClaudeCodeBashToolSchema = z.object({
  tool: z.literal('ClaudeCodeBash'),
  command: z.string(),
  output: z.string().optional(),
})

const ClaudeCodeGlobToolSchema = z.object({
  tool: z.literal('ClaudeCodeGlob'),
  pattern: z.string(),
  results: z.array(z.string()).optional(),
})

const ClaudeCodeGrepToolSchema = z.object({
  tool: z.literal('ClaudeCodeGrep'),
  pattern: z.string(),
  results: z.string().optional(),
})

// Codex tool call schemas
const CodexShellToolSchema = z.object({
  tool: z.literal('CodexShell'),
  command: z.string(),
  output: z.string().optional(),
  exit_code: z.number().optional(),
})

// Unknown tool for tools we don't recognize yet
const UnknownToolSchema = z.object({
  tool: z.literal('Unknown'),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
})

const ToolCallSchema = z.discriminatedUnion('tool', [
  ClaudeCodeReadToolSchema,
  ClaudeCodeEditToolSchema,
  ClaudeCodeWriteToolSchema,
  ClaudeCodeBashToolSchema,
  ClaudeCodeGlobToolSchema,
  ClaudeCodeGrepToolSchema,
  CodexShellToolSchema,
  UnknownToolSchema,
])

// Message item schemas
const UserMessageSchema = z.object({
  role: z.literal('user'),
  text: z.string(),
})

const AssistantTextMessageSchema = z.object({
  role: z.literal('assistant'),
  text: z.string(),
})

const AssistantThinkingMessageSchema = z.object({
  role: z.literal('assistant'),
  thinking: z.string(),
})

const AssistantToolMessageSchema = z.object({
  role: z.literal('assistant'),
  call: ToolCallSchema,
})

const MessageItemSchema = z.discriminatedUnion('role', [
  UserMessageSchema,
  AssistantTextMessageSchema,
  AssistantThinkingMessageSchema,
  AssistantToolMessageSchema,
])

// Main transcript schema
const UnifiedTranscriptSchema = z.object({
  v: z.literal(1),
  id: z.string(),
  source: z.enum(['claude-code', 'codex']),
  timestamp: z.date(),
  relativeTime: z.string(),
  preview: z.string(),
  model: z.string(),
  blendedTokens: z.number(),
  costUsd: z.number(),
  messageCount: z.number(),
  branchMarker: z.string(),
  messages: z.array(MessageItemSchema),
})

// Export types
export type ClaudeCodeReadTool = z.infer<typeof ClaudeCodeReadToolSchema>
export type ClaudeCodeEditTool = z.infer<typeof ClaudeCodeEditToolSchema>
export type ClaudeCodeWriteTool = z.infer<typeof ClaudeCodeWriteToolSchema>
export type ClaudeCodeBashTool = z.infer<typeof ClaudeCodeBashToolSchema>
export type ClaudeCodeGlobTool = z.infer<typeof ClaudeCodeGlobToolSchema>
export type ClaudeCodeGrepTool = z.infer<typeof ClaudeCodeGrepToolSchema>
export type CodexShellTool = z.infer<typeof CodexShellToolSchema>
export type UnknownTool = z.infer<typeof UnknownToolSchema>
export type ToolCall = z.infer<typeof ToolCallSchema>

export type UserMessage = z.infer<typeof UserMessageSchema>
export type AssistantTextMessage = z.infer<typeof AssistantTextMessageSchema>
export type AssistantThinkingMessage = z.infer<typeof AssistantThinkingMessageSchema>
export type AssistantToolMessage = z.infer<typeof AssistantToolMessageSchema>
export type MessageItem = z.infer<typeof MessageItemSchema>

export type UnifiedTranscript = z.infer<typeof UnifiedTranscriptSchema>

// Export schemas
export {
  UnifiedTranscriptSchema,
  MessageItemSchema,
  ToolCallSchema,
}
