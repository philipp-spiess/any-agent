import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  blendedTokenTotal,
  markForkedSessions,
  orderSessionsByBranch,
  type SessionSummary,
  type SessionsWithTotals,
  type TokenUsage,
} from './codex'
import { LiteLLMPricingFetcher, type LiteLLMModelPricing } from './pricing'

type ClaudeSessionsOptions = {
  claudeDirs?: string[]
  limit?: number
  pricingFetcher?: LiteLLMPricingFetcher
  pricingOfflineData?: Record<string, LiteLLMModelPricing>
}

type TranscriptSummary = {
  leafUuid: string
  summary: string
}

type TranscriptFile = {
  path: string
  projectId: string
  mtimeMs: number
}

type ClaudeMessageBase = {
  uuid: string
  timestamp?: string
  parentUuid?: string | null
  isSidechain?: boolean
  sessionId?: string
  cwd?: string
  costUSD?: number
  message?: {
    id?: string
    role?: string
    content?: unknown
    model?: string
    usage?: ClaudeUsage | null
  }
  raw: Record<string, unknown>
}

type ClaudeUsage = {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
}

type ClaudeSummaryRecord = TranscriptSummary & {
  projectId: string
  filePath: string
}

type ClaudeMessageRecord = ClaudeMessageBase & {
  type: string
  projectId: string
  filePath: string
}

type ClaudeUsageDetail = {
  model: string | null
  usage: ClaudeUsage
}

const MAX_HEAD_RECORDS = 20
const DEFAULT_LIMIT = Number.POSITIVE_INFINITY
const CLAUDE_FILE_EXTENSION = '.jsonl'

const defaultPricingFetcher = new LiteLLMPricingFetcher()

export async function getClaudeSessions(
  options: ClaudeSessionsOptions = {},
): Promise<SessionsWithTotals> {
  const {
    claudeDirs = resolveClaudeDataDirs(),
    limit,
    pricingFetcher: providedPricingFetcher,
    pricingOfflineData,
  } = options

  if (claudeDirs.length === 0) {
    return { sessions: [], totalBlendedTokens: 0, totalCostUsd: 0 }
  }

  const transcriptFiles = await collectTranscriptFiles(claudeDirs)
  if (transcriptFiles.length === 0) {
    return { sessions: [], totalBlendedTokens: 0, totalCostUsd: 0 }
  }

  const summaries = new Map<string, ClaudeSummaryRecord>()
  const messages = new Map<string, ClaudeMessageRecord>()
  const parentLookup = new Map<string, Set<string>>()
  const leafToFile = new Map<string, TranscriptFile>()

  for (const file of transcriptFiles) {
    await parseTranscriptFile(file, summaries, messages, parentLookup, leafToFile)
  }

  const leafMessages = identifyLeafMessages(messages, parentLookup)

  let sessions: SessionSummary[] = []
  const seenSessions = new Set<string>()
  const effectiveLimit = limit ?? DEFAULT_LIMIT
  const globalMessageKeys = new Set<string>()
  const sessionUsageDetails = new Map<string, ClaudeUsageDetail[]>()

  const orderedLeaves = leafMessages.sort((a, b) => {
    const timeA = timestampToNumber(a.timestamp) ?? 0
    const timeB = timestampToNumber(b.timestamp) ?? 0
    return timeA - timeB
  })

  for (const leaf of orderedLeaves) {
    if (seenSessions.has(leaf.uuid)) {
      continue
    }

    const transcript = buildTranscript(leaf, messages)
    if (!transcript) {
      continue
    }

    const nonSummaryMessages = transcript.filter(message => message.type !== 'summary')
    if (nonSummaryMessages.length === 0) {
      continue
    }

    const hasPrimaryMessage = nonSummaryMessages.some(message => !message.isSidechain)
    if (!hasPrimaryMessage) {
      continue
    }

    const file = leafToFile.get(leaf.uuid)
    const summaryRecord = summaries.get(leaf.uuid)

    const assistantMessages = collectAssistantUsageMessages(transcript)
    const usageMessagesWithKeys: Array<{ key: string; message: ClaudeMessageRecord }> = []
    for (const message of assistantMessages) {
      const key = getAssistantUsageKey(message)
      if (globalMessageKeys.has(key)) {
        continue
      }
      usageMessagesWithKeys.push({ key, message })
    }

    if (usageMessagesWithKeys.length === 0) {
      continue
    }

    const usageMessages = usageMessagesWithKeys.map(entry => entry.message)

    const usageDetails: ClaudeUsageDetail[] = usageMessages.map(message => ({
      model: typeof message.message?.model === 'string' ? message.message.model : null,
      usage: message.message?.usage as ClaudeUsage,
    }))

    const session = createSessionSummary(
      leaf,
      transcript,
      usageMessages,
      file ?? null,
      summaryRecord ?? null,
    )

    if (!session) {
      continue
    }

    sessions.push(session)
    seenSessions.add(session.id)
    sessionUsageDetails.set(session.id, usageDetails)

    for (const { key } of usageMessagesWithKeys) {
      globalMessageKeys.add(key)
    }
  }

  sessions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  if (Number.isFinite(effectiveLimit) && sessions.length > effectiveLimit) {
    sessions = sessions.slice(0, effectiveLimit)
  }

  markForkedSessions(sessions)

  const orderedSessions = orderSessionsByBranch(sessions)
  const visibleSessions = orderedSessions.filter(session =>
    hasAnyTokenUsage(session.tokenUsage),
  )

  const pricingFetcher =
    providedPricingFetcher ??
    (pricingOfflineData
      ? new LiteLLMPricingFetcher({
          offline: true,
          offlineLoader: async () => pricingOfflineData,
        })
      : defaultPricingFetcher)

  const pricingCache = new Map<string, LiteLLMModelPricing | null>()
  let totalCostUsd = 0

  for (const session of visibleSessions) {
    session.costUsd = 0
    const usageDetails = sessionUsageDetails.get(session.id) ?? []

    for (const detail of usageDetails) {
      const modelName = detail.model
      if (!modelName) {
        continue
      }

      if (!pricingCache.has(modelName)) {
        try {
          const pricing = await pricingFetcher.getModelPricing(modelName)
          pricingCache.set(modelName, pricing)
        } catch (error) {
          console.warn(`Failed to fetch pricing for model ${modelName}:`, error)
          pricingCache.set(modelName, null)
        }
      }

      const pricing = pricingCache.get(modelName)
      if (!pricing) {
        continue
      }

      const usage = detail.usage
      const cost = pricingFetcher.calculateCostFromPricing(
        {
          input_tokens: ensureNumber(usage.input_tokens),
          output_tokens: ensureNumber(usage.output_tokens),
          cache_creation_input_tokens: ensureNumber(usage.cache_creation_input_tokens),
          cache_read_input_tokens: ensureNumber(usage.cache_read_input_tokens),
        },
        pricing,
      )

      session.costUsd += cost
    }

    totalCostUsd += session.costUsd
  }

  const totalBlendedTokens = visibleSessions.reduce(
    (acc, session) => acc + session.blendedTokens,
    0,
  )

  return { sessions: visibleSessions, totalBlendedTokens, totalCostUsd }
}

function resolveClaudeDataDirs(): string[] {
  const env = process.env.CLAUDE_CONFIG_DIR
  const dirs = new Set<string>()

  if (env && env.trim().length > 0) {
    for (const entry of env.split(',').map(part => part.trim()).filter(Boolean)) {
      dirs.add(resolveProjectsDir(entry))
    }
  }

  const defaultDirs = [
    path.join(os.homedir(), '.config', 'claude'),
    path.join(os.homedir(), '.claude'),
  ]

  for (const base of defaultDirs) {
    dirs.add(resolveProjectsDir(base))
  }

  return Array.from(dirs).filter(Boolean)
}

function resolveProjectsDir(baseDir: string): string {
  const normalized = baseDir.replace(/~/g, os.homedir())
  return normalized.endsWith(path.sep + 'projects') || normalized.endsWith('/projects')
    ? normalized
    : path.join(normalized, 'projects')
}

async function collectTranscriptFiles(claudeDirs: string[]): Promise<TranscriptFile[]> {
  const files: TranscriptFile[] = []

  for (const dir of claudeDirs) {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Failed to read Claude projects directory ${dir}:`, error)
      }
      continue
    }

    for (const projectId of entries) {
      const projectPath = path.join(dir, projectId)
      let stat
      try {
        stat = await fs.stat(projectPath)
      } catch {
        continue
      }
      if (!stat.isDirectory()) {
        continue
      }

      let projectFiles: string[]
      try {
        projectFiles = await fs.readdir(projectPath)
      } catch {
        continue
      }

      for (const fileName of projectFiles) {
        if (!fileName.endsWith(CLAUDE_FILE_EXTENSION)) {
          continue
        }

        const filePath = path.join(projectPath, fileName)
        try {
          const fileStat = await fs.stat(filePath)
          files.push({
            path: filePath,
            projectId,
            mtimeMs: fileStat.mtime.getTime(),
          })
        } catch {
          continue
        }
      }
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return files
}

async function parseTranscriptFile(
  file: TranscriptFile,
  summaries: Map<string, ClaudeSummaryRecord>,
  messages: Map<string, ClaudeMessageRecord>,
  parentLookup: Map<string, Set<string>>,
  leafToFile: Map<string, TranscriptFile>,
): Promise<void> {
  let content: string
  try {
    content = await fs.readFile(file.path, 'utf8')
  } catch (error) {
    console.warn(`Failed to read Claude transcript ${file.path}:`, error)
    return
  }

  const lines = content.split('\n')
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    const type = typeof parsed.type === 'string' ? parsed.type : ''
    if (type === 'summary') {
      const leafUuid = typeof parsed.leafUuid === 'string' ? parsed.leafUuid : null
      const summary = typeof parsed.summary === 'string' ? parsed.summary : null
      if (!leafUuid || !summary) {
        continue
      }
      summaries.set(leafUuid, {
        leafUuid,
        summary,
        projectId: file.projectId,
        filePath: file.path,
      })
      leafToFile.set(leafUuid, file)
      continue
    }

    const uuid = typeof parsed.uuid === 'string' ? parsed.uuid : null
    if (!uuid) {
      continue
    }

    const message: ClaudeMessageRecord = {
      uuid,
      type,
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
      parentUuid: typeof parsed.parentUuid === 'string' || parsed.parentUuid === null
        ? (parsed.parentUuid as string | null | undefined)
        : undefined,
      isSidechain: Boolean(parsed.isSidechain),
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
      costUSD: typeof parsed.costUSD === 'number' ? parsed.costUSD : undefined,
      projectId: file.projectId,
      filePath: file.path,
      message: extractMessagePayload(parsed.message),
      raw: parsed,
    }

    messages.set(uuid, message)
    leafToFile.set(uuid, file)

    const parentUuid = message.parentUuid
    if (parentUuid) {
      const children = parentLookup.get(parentUuid) ?? new Set<string>()
      children.add(uuid)
      parentLookup.set(parentUuid, children)
    }
  }
}

function extractMessagePayload(value: unknown): ClaudeMessageBase['message'] {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : undefined
  const role = typeof record.role === 'string' ? record.role : undefined
  const content = record.content
  const model = typeof record.model === 'string' ? record.model : undefined
  const usage = extractUsage(record.usage)
  return { id, role, content, model, usage }
}

function extractUsage(value: unknown): ClaudeUsage | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  const usage: ClaudeUsage = {}
  if (typeof record.input_tokens === 'number') {
    usage.input_tokens = record.input_tokens
  }
  if (typeof record.cache_creation_input_tokens === 'number') {
    usage.cache_creation_input_tokens = record.cache_creation_input_tokens
  }
  if (typeof record.cache_read_input_tokens === 'number') {
    usage.cache_read_input_tokens = record.cache_read_input_tokens
  }
  if (typeof record.output_tokens === 'number') {
    usage.output_tokens = record.output_tokens
  }
  if (typeof record.reasoning_output_tokens === 'number') {
    usage.reasoning_output_tokens = record.reasoning_output_tokens
  }
  return Object.keys(usage).length > 0 ? usage : null
}

function identifyLeafMessages(
  messages: Map<string, ClaudeMessageRecord>,
  parentLookup: Map<string, Set<string>>,
): ClaudeMessageRecord[] {
  const leaves: ClaudeMessageRecord[] = []
  for (const message of messages.values()) {
    if (!parentLookup.has(message.uuid)) {
      leaves.push(message)
    }
  }
  return leaves
}

function buildTranscript(
  leaf: ClaudeMessageRecord,
  messages: Map<string, ClaudeMessageRecord>,
): ClaudeMessageRecord[] | null {
  const transcript: ClaudeMessageRecord[] = []
  const visited = new Set<string>()
  let current: ClaudeMessageRecord | undefined = leaf

  while (current) {
    if (visited.has(current.uuid)) {
      break
    }
    visited.add(current.uuid)
    transcript.unshift(current)
    const parentUuid = current.parentUuid ?? undefined
    if (!parentUuid) {
      break
    }
    current = messages.get(parentUuid)
  }

  return transcript.length > 0 ? transcript : null
}

function createSessionSummary(
  leaf: ClaudeMessageRecord,
  transcript: ClaudeMessageRecord[],
  usageMessages: ClaudeMessageRecord[],
  file: TranscriptFile | null,
  summary: ClaudeSummaryRecord | null,
): SessionSummary | null {
  const timestamp = parseDate(leaf.timestamp) ?? (file ? new Date(file.mtimeMs) : null)
  if (!timestamp) {
    return null
  }

  if (usageMessages.length === 0) {
    return null
  }

  const tokenUsage = aggregateUsage(usageMessages)
  const modelUsage = aggregateUsageByModel(usageMessages)
  const blendedTokens = blendedTokenTotal(tokenUsage)

  const firstUserMessage = findFirstUserMessage(transcript)
  const preview = firstUserMessage ? summarizeMessage(firstUserMessage) : null
  const cwd = deriveWorkingDirectory(transcript, file)
  const forkSignature = firstUserMessage ? summarizeMessage(firstUserMessage, 120) : null

  const primaryModel = selectPrimaryModel(modelUsage)

  const session: SessionSummary = {
    id: leaf.uuid,
    source: 'claude-code',
    path: file?.path ?? '',
    timestamp,
    timestampUtc: timestamp.toISOString(),
    relativeTime: formatRelativeTime(timestamp),
    preview,
    meta: {
      source: 'claude-code',
      summary: summary?.summary,
      projectPath: decodeProjectPath(file?.projectId),
      claudeProjectId: file?.projectId,
      transcriptFile: file?.path,
      messageCount: transcript.length,
      cwd,
    },
    head: transcript.slice(0, MAX_HEAD_RECORDS).map(entry => entry.raw),
    tokenUsage,
    blendedTokens,
    isFork: false,
    branchMarker: ' ',
    forkSignature,
    model: primaryModel,
    costUsd: 0,
    modelUsage,
    messageCount: transcript.length,
  }

  return session
}

function collectAssistantUsageMessages(
  transcript: ClaudeMessageRecord[],
): ClaudeMessageRecord[] {
  const unique = new Map<string, ClaudeMessageRecord>()

  for (const message of transcript) {
    if (message.type !== 'assistant') {
      continue
    }

    const payload = message.message
    if (!payload?.usage) {
      continue
    }

    const key = getAssistantUsageKey(message)
    unique.set(key, message)
  }

  return Array.from(unique.values())
}

function getAssistantUsageKey(message: ClaudeMessageRecord): string {
  const payload = message.message
  const messageId = asNonEmptyString(payload?.id)
  const requestId = asNonEmptyString((message.raw as Record<string, unknown>).requestId)
  if (messageId && requestId) {
    return `${messageId}:${requestId}`
  }
  if (messageId) {
    return messageId
  }
  if (requestId) {
    return requestId
  }
  return message.uuid
}

function aggregateUsage(assistantMessages: ClaudeMessageRecord[]): TokenUsage {
  const usage: TokenUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  }

  for (const message of assistantMessages) {
    const stats = message.message?.usage
    if (!stats) {
      continue
    }
    const input = ensureNumber(stats.input_tokens)
    const cacheCreation = ensureNumber(stats.cache_creation_input_tokens)
    const cacheRead = ensureNumber(stats.cache_read_input_tokens)
    const output = ensureNumber(stats.output_tokens)
    const reasoning = ensureNumber(stats.reasoning_output_tokens)

    usage.inputTokens += input + cacheCreation + cacheRead
    usage.cachedInputTokens += cacheRead
    usage.outputTokens += output
    usage.reasoningOutputTokens += reasoning
    usage.totalTokens += input + cacheCreation + cacheRead + output + reasoning
  }

  return usage
}

function aggregateUsageByModel(
  assistantMessages: ClaudeMessageRecord[],
): Map<string, TokenUsage> {
  const perModel = new Map<string, TokenUsage>()

  for (const message of assistantMessages) {
    const model = message.message?.model
    const usage = message.message?.usage
    if (!model || !usage) {
      continue
    }

    const record = perModel.get(model) ?? {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    }

    const input = ensureNumber(usage.input_tokens)
    const cacheCreation = ensureNumber(usage.cache_creation_input_tokens)
    const cacheRead = ensureNumber(usage.cache_read_input_tokens)
    const output = ensureNumber(usage.output_tokens)
    const reasoning = ensureNumber(usage.reasoning_output_tokens)

    record.inputTokens += input + cacheCreation + cacheRead
    record.cachedInputTokens += cacheRead
    record.outputTokens += output
    record.reasoningOutputTokens += reasoning
    record.totalTokens += input + cacheCreation + cacheRead + output + reasoning

    perModel.set(model, record)
  }

  return perModel
}

function findFirstUserMessage(
  transcript: ClaudeMessageRecord[],
): ClaudeMessageRecord | undefined {
  return transcript.find(message => message.type === 'user')
}

function summarizeMessage(message: ClaudeMessageRecord, maxLength = 80): string | null {
  const payload = message.message
  if (!payload) {
    return null
  }

  const content = payload.content
  if (typeof content === 'string') {
    return truncate(content, maxLength)
  }

  if (Array.isArray(content) && content.length > 0) {
    const first = content[0]
    if (typeof first === 'string') {
      return truncate(first, maxLength)
    }
    if (first && typeof first === 'object') {
      const record = first as Record<string, unknown>
      if (typeof record.content === 'string') {
        return truncate(record.content, maxLength)
      }
      if (typeof record.text === 'string') {
        return truncate(record.text, maxLength)
      }
    }
  }

  return null
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) {
    return normalized
  }
  if (maxLength <= 1) {
    return normalized.slice(0, maxLength)
  }
  return `${normalized.slice(0, maxLength - 1)}…`
}

function deriveWorkingDirectory(
  transcript: ClaudeMessageRecord[],
  file: TranscriptFile | null,
): string | undefined {
  for (const message of transcript) {
    if (message.cwd) {
      return message.cwd
    }
  }
  return decodeProjectPath(file?.projectId)
}

function decodeProjectPath(projectId: string | undefined): string | undefined {
  if (!projectId) {
    return undefined
  }
  if (projectId.startsWith('-')) {
    const replaced = projectId.replace(/-/g, path.sep)
    return replaced.startsWith(path.sep) ? replaced : `${path.sep}${replaced}`
  }
  return projectId
}

function parseDate(value: string | undefined): Date | null {
  if (!value) {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function timestampToNumber(value: string | undefined): number | null {
  const date = parseDate(value)
  return date ? date.getTime() : null
}

function selectPrimaryModel(modelUsage: Map<string, TokenUsage>): string | null {
  let primaryModel: string | null = null
  let highestTokens = -1
  for (const [modelName, usage] of modelUsage) {
    const tokens = usage.totalTokens > 0
      ? usage.totalTokens
      : usage.inputTokens + usage.outputTokens
    if (tokens > highestTokens) {
      highestTokens = tokens
      primaryModel = modelName
    }
  }
  return primaryModel
}

function ensureNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function hasAnyTokenUsage(usage: TokenUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.cachedInputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.reasoningOutputTokens > 0
  )
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = date.getTime() - now.getTime()
  const diffSeconds = Math.round(Math.abs(diffMs) / 1000)

  const units: Array<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
    { unit: 'year', seconds: 31_536_000 },
    { unit: 'month', seconds: 2_592_000 },
    { unit: 'week', seconds: 604_800 },
    { unit: 'day', seconds: 86_400 },
    { unit: 'hour', seconds: 3_600 },
    { unit: 'minute', seconds: 60 },
    { unit: 'second', seconds: 1 },
  ]

  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  for (const { unit, seconds } of units) {
    if (diffSeconds >= seconds || unit === 'second') {
      const value = Math.round(diffMs / (seconds * 1000))
      return formatter.format(value, unit)
    }
  }

  return formatter.format(0, 'second')
}
