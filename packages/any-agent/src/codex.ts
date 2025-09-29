import { createReadStream } from 'node:fs'
import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { LiteLLMPricingFetcher } from './pricing'
import type { LiteLLMModelPricing } from './pricing'

export const CODEX_BRAND_COLOR = 'cyan'

type SessionMetaPayload = {
  id?: string
  timestamp?: string
  instructions?: string | null
  cwd?: string
  originator?: string
  cli_version?: string
  [key: string]: unknown
}

export interface SessionSummary {
  id: string
  source: 'codex' | 'claude-code'
  path: string
  resumeTarget: string
  timestamp: Date
  timestampUtc: string
  relativeTime: string
  preview: string | null
  meta: SessionMetaPayload | null
  head: unknown[]
  tokenUsage: TokenUsage
  blendedTokens: number
  isFork: boolean
  branchMarker: string
  forkSignature: string | null
  model: string | null
  costUsd: number
  modelUsage: Map<string, TokenUsage>
  messageCount: number
}

export interface SessionsWithTotals {
  sessions: SessionSummary[]
  totalBlendedTokens: number
  totalCostUsd: number
}

export interface GetSessionsOptions {
  codexHome?: string
  limit?: number
  headRecordLimit?: number
  scanCap?: number
  pricingFetcher?: LiteLLMPricingFetcher
  pricingOfflineData?: Record<string, LiteLLMModelPricing>
}

export interface TokenUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

const DEFAULT_HEAD_RECORD_LIMIT = 10
const DEFAULT_SCAN_CAP = 500
const ROLLOUT_FILE_PATTERN = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-fA-F-]{36})\.jsonl$/
const defaultPricingFetcher = new LiteLLMPricingFetcher()

export async function getSessions(options: GetSessionsOptions = {}): Promise<SessionsWithTotals> {
  const {
    codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
    limit,
    headRecordLimit = DEFAULT_HEAD_RECORD_LIMIT,
    scanCap = DEFAULT_SCAN_CAP,
    pricingFetcher: providedPricingFetcher,
    pricingOfflineData,
  } = options

  const sessionsRoot = path.join(codexHome, 'sessions')

  let rootStats: Stats | undefined
  try {
    rootStats = await fs.stat(sessionsRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { sessions: [], totalBlendedTokens: 0, totalCostUsd: 0 }
    }
    throw error
  }

  if (!rootStats.isDirectory()) {
    return { sessions: [], totalBlendedTokens: 0, totalCostUsd: 0 }
  }

  const sessions: SessionSummary[] = []
  let scannedFiles = 0

  const yearDirs = await collectDirsDesc(sessionsRoot, parseNumber)

  outer: for (const year of yearDirs) {
    const monthDirs = await collectDirsDesc(year.path, parseNumber)
    for (const month of monthDirs) {
      const dayDirs = await collectDirsDesc(month.path, parseNumber)
      for (const day of dayDirs) {
        const files = await collectSessionFiles(day.path)
        for (const file of files) {
          scannedFiles += 1
          if (scannedFiles > scanCap) {
            break outer
          }

          const {
            head,
            meta,
            firstUserMessage,
            tokenUsage,
            modelUsage,
            messageCount,
          } = await readHead(
            file.path,
            headRecordLimit,
          )
          if (!meta || !firstUserMessage) {
            continue
          }

          const id = typeof meta.id === 'string' && meta.id.length > 0 ? meta.id : file.id
          if (!id) {
            continue
          }

          const timestamp = file.timestamp ?? parseTimestamp(meta.timestamp ?? file.timestampUtc)
          if (!timestamp) {
            continue
          }

          const blendedTokens = blendedTokenTotal(tokenUsage)
          const forkSignature = computeForkSignature(head)

          const preview = summarize(firstUserMessage)

          let primaryModel: string | null = null
          let primaryTokens = -1
          for (const [modelName, usage] of modelUsage) {
            const tokens = usage.totalTokens > 0
              ? usage.totalTokens
              : usage.inputTokens + usage.outputTokens
            if (tokens > primaryTokens) {
              primaryTokens = tokens
              primaryModel = modelName
            }
          }

          sessions.push({
            id,
            source: 'codex',
            path: file.path,
            resumeTarget: id,
            timestamp,
            timestampUtc: timestamp.toISOString(),
            relativeTime: formatRelativeTime(timestamp),
            preview,
            meta,
            head,
            tokenUsage,
            blendedTokens,
            isFork: false,
            branchMarker: ' ',
            forkSignature,
            model: primaryModel,
            costUsd: 0,
            modelUsage,
            messageCount,
          })

          if (limit && sessions.length >= limit) {
            break outer
          }
        }
      }
    }
  }

  markForkedSessions(sessions)

  const ordered = orderSessionsByBranch(sessions).filter(session => {
    const usage = session.tokenUsage
    return (
      usage.inputTokens > 0 ||
      usage.cachedInputTokens > 0 ||
      usage.outputTokens > 0 ||
      usage.reasoningOutputTokens > 0
    )
  })

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

  for (const session of ordered) {
    session.costUsd = 0
    const model = session.model
    if (!model) {
      continue
    }

    if (!pricingCache.has(model)) {
      try {
        const pricing = await pricingFetcher.getModelPricing(model)
        pricingCache.set(model, pricing)
      } catch (error) {
        console.warn(`Failed to fetch pricing for model ${model}:`, error)
        pricingCache.set(model, null)
      }
    }

    let sessionCost = 0
    for (const [modelName, usage] of session.modelUsage) {
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

      const nonCachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens)
      const cachedInput = usage.cachedInputTokens
      const cost = pricingFetcher.calculateCostFromPricing(
        {
          input_tokens: nonCachedInput,
          output_tokens: usage.outputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: cachedInput,
        },
        pricing,
      )
      sessionCost += cost
    }

    session.costUsd = sessionCost
    totalCostUsd += sessionCost
  }

  const totalBlendedTokens = ordered.reduce((acc, s) => acc + s.blendedTokens, 0)
  return {
    sessions: ordered,
    totalBlendedTokens,
    totalCostUsd,
  }
}

type DirEntryWithKey = {
  key: number
  path: string
}

type SessionFile = {
  path: string
  timestampUtc: string
  timestamp: Date | null
  id: string | null
}

async function collectDirsDesc(base: string, parse: (name: string) => number | null): Promise<DirEntryWithKey[]> {
  const entries = await fs.readdir(base, { withFileTypes: true })
  const result: DirEntryWithKey[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const key = parse(entry.name)
    if (key === null) {
      continue
    }
    result.push({ key, path: path.join(base, entry.name) })
  }

  result.sort((a, b) => b.key - a.key)
  return result
}

async function collectSessionFiles(base: string): Promise<SessionFile[]> {
  const entries = await fs.readdir(base, { withFileTypes: true })
  const files: SessionFile[] = []

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }

    const match = ROLLOUT_FILE_PATTERN.exec(entry.name)
    if (!match) {
      continue
    }

    const [, timestampUtc, id] = match
    files.push({
      path: path.join(base, entry.name),
      timestampUtc,
      timestamp: parseTimestamp(timestampUtc),
      id,
    })
  }

  files.sort((a, b) => {
    if (!a.timestamp || !b.timestamp) {
      return 0
    }
    const diff = b.timestamp.getTime() - a.timestamp.getTime()
    if (diff !== 0) {
      return diff
    }
    const idA = a.id ?? ''
    const idB = b.id ?? ''
    return idB.localeCompare(idA)
  })

  return files
}

function parseNumber(value: string): number | null {
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}

function parseTimestamp(value: string | undefined): Date | null {
  if (!value) {
    return null
  }

  const normalized = normalizeTimestamp(value)
  if (!normalized) {
    return null
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(normalized)
  if (!match) {
    return null
  }

  const [, year, month, day, hour, minute, second] = match
  const date = new Date(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(minute, 10),
    Number.parseInt(second, 10),
  )
  return Number.isNaN(date.getTime()) ? null : date
}

function normalizeTimestamp(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }

  // Accept both `T12-34-56` and `T12:34:56` (optionally ending with `Z`).
  const withoutZone = trimmed.replace(/Z$/, '')
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})[:\-](\d{2})[:\-](\d{2})$/.exec(withoutZone)
  if (!match) {
    return null
  }

  const [, date, hh, mm, ss] = match
  return `${date}T${hh}-${mm}-${ss}`
}

const DEFAULT_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
}

type RawUsage = {
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
  total_tokens: number
}

const LEGACY_FALLBACK_MODEL = 'gpt-5-codex'

function createEmptyUsage(): TokenUsage {
  return { ...DEFAULT_TOKEN_USAGE }
}

function addUsage(target: TokenUsage, delta: RawUsage): void {
  target.inputTokens += delta.input_tokens
  target.cachedInputTokens += delta.cached_input_tokens
  target.outputTokens += delta.output_tokens
  target.reasoningOutputTokens += delta.reasoning_output_tokens
  target.totalTokens += delta.total_tokens
}

function ensureNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeRawUsage(value: unknown): RawUsage | null {
  if (value == null || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  const input = ensureNumber(record.input_tokens)
  const cached = ensureNumber(record.cached_input_tokens ?? record.cache_read_input_tokens)
  const output = ensureNumber(record.output_tokens)
  const reasoning = ensureNumber(record.reasoning_output_tokens)
  const total = ensureNumber(record.total_tokens)

  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total > 0 ? total : input + output,
  }
}

function subtractRawUsage(current: RawUsage, previous: RawUsage | null): RawUsage {
  if (!previous) {
    return current
  }
  return {
    input_tokens: Math.max(current.input_tokens - previous.input_tokens, 0),
    cached_input_tokens: Math.max(current.cached_input_tokens - previous.cached_input_tokens, 0),
    output_tokens: Math.max(current.output_tokens - previous.output_tokens, 0),
    reasoning_output_tokens: Math.max(
      current.reasoning_output_tokens - previous.reasoning_output_tokens,
      0,
    ),
    total_tokens: Math.max(current.total_tokens - previous.total_tokens, 0),
  }
}

function convertToDelta(raw: RawUsage): RawUsage {
  const cached = Math.min(raw.cached_input_tokens, raw.input_tokens)
  const total = raw.total_tokens > 0 ? raw.total_tokens : raw.input_tokens + raw.output_tokens
  return {
    input_tokens: raw.input_tokens,
    cached_input_tokens: cached,
    output_tokens: raw.output_tokens,
    reasoning_output_tokens: raw.reasoning_output_tokens,
    total_tokens: total,
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function extractModelFromRecord(record: Record<string, unknown>): string | undefined {
  const directCandidates = [record.model, record.model_name]
  for (const candidate of directCandidates) {
    const model = asNonEmptyString(candidate)
    if (model) {
      return model
    }
  }
  const metadata = record.metadata
  if (metadata && typeof metadata === 'object') {
    const model = asNonEmptyString((metadata as Record<string, unknown>).model)
    if (model) {
      return model
    }
  }
  return undefined
}

function extractModel(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const model = extractModelFromRecord(record)
    if (model) {
      return model
    }
    const info = record.info
    if (info && typeof info === 'object') {
      const infoModel = extractModelFromRecord(info as Record<string, unknown>)
      if (infoModel) {
        return infoModel
      }
    }
  }
  return undefined
}

async function readHead(filePath: string, limit: number): Promise<{
  head: unknown[]
  meta: SessionMetaPayload | null
  firstUserMessage: string | null
  tokenUsage: TokenUsage
  modelUsage: Map<string, TokenUsage>
  messageCount: number
}> {
  const head: unknown[] = []
  let meta: SessionMetaPayload | null = null
  let firstUserMessage: string | null = null
  const totals = createEmptyUsage()
  const perModel = new Map<string, TokenUsage>()
  let previousTotals: RawUsage | null = null
  let currentModel: string | null = null
  let messageCount = 0

  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  try {
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }

      if (head.length < limit) {
        head.push(parsed)
      }

      if (!meta && isSessionMeta(parsed)) {
        meta = parsed.payload
      }

      if (!firstUserMessage && isUserEvent(parsed)) {
        const { message } = parsed.payload
        if (typeof message === 'string' && message.trim().length > 0) {
          firstUserMessage = message
        }
      }

      if (isMessageEvent(parsed)) {
        messageCount += 1
      }

      if (isTurnContext(parsed)) {
        const contextModel = asNonEmptyString(parsed.payload.model)
        if (contextModel) {
          currentModel = contextModel
        }
        continue
      }

      if (!isTokenCountRecord(parsed)) {
        continue
      }

      const payloadRecord = parsed as TokenCountRecord
      const infoRecord = payloadRecord.payload.info
      const lastUsage = normalizeRawUsage(infoRecord?.last_token_usage)
      const totalUsage = normalizeRawUsage(infoRecord?.total_token_usage)

      let raw = lastUsage
      if (!raw && totalUsage) {
        raw = subtractRawUsage(totalUsage, previousTotals)
      }
      if (totalUsage) {
        previousTotals = totalUsage
      }
      if (!raw) {
        continue
      }

      const delta = convertToDelta(raw)
      if (
        delta.input_tokens === 0 &&
        delta.cached_input_tokens === 0 &&
        delta.output_tokens === 0 &&
        delta.reasoning_output_tokens === 0
      ) {
        continue
      }

      addUsage(totals, delta)

      const modelName =
        extractModel(payloadRecord.payload) ?? currentModel ?? LEGACY_FALLBACK_MODEL
      if (!perModel.has(modelName)) {
        perModel.set(modelName, createEmptyUsage())
      }
      const usage = perModel.get(modelName)!
      addUsage(usage, delta)
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  return {
    head,
    meta,
    firstUserMessage,
    tokenUsage: totals,
    modelUsage: perModel,
    messageCount,
  }
}

type SessionMetaRecord = {
  type: 'session_meta'
  payload: SessionMetaPayload
}

type UserEventRecord = {
  type: 'event_msg'
  payload: {
    type: 'user_message'
    message: unknown
  }
}

type MessageEventRecord = {
  type: 'event_msg'
  payload: {
    type?: unknown
  }
}

type TurnContextRecord = {
  type: 'turn_context'
  payload: {
    model?: unknown
  }
}

function isSessionMeta(value: unknown): value is SessionMetaRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  if ((value as { type?: unknown }).type !== 'session_meta') {
    return false
  }

  const payload = (value as { payload?: unknown }).payload
  return typeof payload === 'object' && payload !== null
}

function isTurnContext(value: unknown): value is TurnContextRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  if ((value as { type?: unknown }).type !== 'turn_context') {
    return false
  }

  return true
}

function isUserEvent(value: unknown): value is UserEventRecord {
  if (
    typeof value !== 'object' ||
    value === null ||
    !(value as { type?: unknown }).type ||
    (value as { type: unknown }).type !== 'event_msg'
  ) {
    return false
  }

  const payload = (value as { payload?: unknown }).payload
  if (!payload || typeof payload !== 'object') {
    return false
  }

  return (payload as { type?: unknown }).type === 'user_message'
}

function isMessageEvent(value: unknown): value is MessageEventRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  if ((value as { type?: unknown }).type !== 'event_msg') {
    return false
  }

  const payload = (value as { payload?: unknown }).payload
  if (!payload || typeof payload !== 'object') {
    return false
  }

  const payloadType = (payload as { type?: unknown }).type
  if (typeof payloadType !== 'string') {
    return false
  }

  return payloadType.toLowerCase().includes('message')
}

type TokenCountRecord = {
  type: 'event_msg'
  payload: {
    type: 'token_count'
    info?: {
      last_token_usage?: {
        input_tokens?: number
        cached_input_tokens?: number
        cache_read_input_tokens?: number
        output_tokens?: number
        reasoning_output_tokens?: number
        total_tokens?: number
      }
      total_token_usage?: {
        input_tokens?: number
        cached_input_tokens?: number
        cache_read_input_tokens?: number
        output_tokens?: number
        reasoning_output_tokens?: number
        total_tokens?: number
      }
    }
  }
}

function isTokenCountRecord(value: unknown): value is TokenCountRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  if ((value as { type?: unknown }).type !== 'event_msg') {
    return false
  }

  const payload = (value as { payload?: unknown }).payload
  if (!payload || typeof payload !== 'object') {
    return false
  }

  return (payload as { type?: unknown }).type === 'token_count'
}

export function blendedTokenTotal(usage: TokenUsage): number {
  const nonCached = Math.max(0, usage.inputTokens - usage.cachedInputTokens)
  return nonCached + usage.outputTokens + usage.reasoningOutputTokens
}

export function markForkedSessions(sessions: SessionSummary[]): void {
  const signatureMap = new Map<string, SessionSummary[]>()

  for (const session of sessions) {
    const signature = session.forkSignature
    if (!signature) {
      continue
    }
    const existing = signatureMap.get(signature)
    if (existing) {
      existing.push(session)
    } else {
      signatureMap.set(signature, [session])
    }
  }

  for (const bucket of signatureMap.values()) {
    if (bucket.length <= 1) {
      continue
    }
    const sortedByTimestamp = [...bucket].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    )
    const baseSession = sortedByTimestamp[0]
    for (const session of sortedByTimestamp.slice(1)) {
      if (session === baseSession) {
        continue
      }
      session.isFork = true
    }
    setBranchMarkers(sortedByTimestamp)
  }
}

function computeForkSignature(head: unknown[]): string | null {
  for (const entry of head) {
    if (isUserEvent(entry)) {
      const message = entry.payload.message
      if (typeof message === 'string') {
        const trimmed = message.trim()
        if (trimmed.length > 0) {
          return trimmed
        }
      }
    }
  }
  return null
}

function setBranchMarkers(group: SessionSummary[]): void {
  if (group.length === 0) {
    return
  }

  const sorted = [...group].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  const base = sorted.pop()
  if (base) {
    base.branchMarker = '┴'
  }

  sorted.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  sorted.forEach((session, index) => {
    session.branchMarker = index === 0 ? '┌' : '├'
  })
}

export function orderSessionsByBranch(sessions: SessionSummary[]): SessionSummary[] {
  const groupsMap = new Map<string, { sessions: SessionSummary[]; maxTimestamp: number }>()
  const singles: SessionSummary[] = []

  for (const session of sessions) {
    const trimmedMarker = session.branchMarker.trim()
    if (trimmedMarker.length > 0) {
      const key = session.forkSignature ?? session.id
      const entry = groupsMap.get(key)
      if (entry) {
        entry.sessions.push(session)
        entry.maxTimestamp = Math.max(entry.maxTimestamp, session.timestamp.getTime())
      } else {
        groupsMap.set(key, {
          sessions: [session],
          maxTimestamp: session.timestamp.getTime(),
        })
      }
    } else {
      singles.push(session)
    }
  }

  const groupEntries = Array.from(groupsMap.values())
  for (const entry of groupEntries) {
    entry.sessions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }
  groupEntries.sort((a, b) => b.maxTimestamp - a.maxTimestamp)

  singles.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

  const ordered: SessionSummary[] = []
  let groupIndex = 0
  let singleIndex = 0

  while (groupIndex < groupEntries.length || singleIndex < singles.length) {
    const nextGroupTs =
      groupIndex < groupEntries.length ? groupEntries[groupIndex].maxTimestamp : -Infinity
    const nextSingleTs =
      singleIndex < singles.length ? singles[singleIndex].timestamp.getTime() : -Infinity

    if (nextGroupTs >= nextSingleTs) {
      ordered.push(...groupEntries[groupIndex].sessions)
      groupIndex += 1
    } else {
      ordered.push(singles[singleIndex])
      singleIndex += 1
    }
  }

  return ordered
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

function summarize(message: string, maxLength = 80): string {
  const singleLine = message.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= maxLength) {
    return singleLine
  }
  return `${singleLine.slice(0, maxLength - 1)}…`
}
