import { afterEach, expect, test, vi } from 'vitest'
import { getAllSessions, type SessionSourceFilter } from '../src/index'
import type { SessionSummary, SessionsWithTotals, TokenUsage } from '../src/codex'
import * as codexModule from '../src/codex'
import * as claudeModule from '../src/claudecode'

const makeTokenUsage = (tokens: number): TokenUsage => ({
  inputTokens: tokens,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: tokens,
})

const makeSession = (
  source: SessionSummary['source'],
  id: string,
  timestamp: Date,
  tokens: number,
  costUsd: number,
): SessionSummary => ({
  id,
  source,
  path: `/tmp/${id}`,
  timestamp,
  timestampUtc: timestamp.toISOString(),
  relativeTime: 'just now',
  preview: `${source} preview`,
  meta: null,
  head: [],
  tokenUsage: makeTokenUsage(tokens),
  blendedTokens: tokens,
  isFork: false,
  branchMarker: ' ',
  forkSignature: null,
  model: 'test-model',
  costUsd,
  modelUsage: new Map([[
    'test-model',
    makeTokenUsage(tokens),
  ]]),
})

const makeResult = (sessions: SessionSummary[]): SessionsWithTotals => ({
  sessions,
  totalBlendedTokens: sessions.reduce((sum, session) => sum + session.blendedTokens, 0),
  totalCostUsd: sessions.reduce((sum, session) => sum + session.costUsd, 0),
})

afterEach(() => {
  vi.restoreAllMocks()
})

const runWithFilter = async (filter: SessionSourceFilter) => {
  return getAllSessions(filter)
}

test('returns only codex sessions when codex filter is provided', async () => {
  const codexSession = makeSession('codex', 'codex-1', new Date('2024-01-01T12:00:00Z'), 10, 1)
  const codexResult = makeResult([codexSession])
  const codexSpy = vi
    .spyOn(codexModule, 'getSessions')
    .mockResolvedValue(codexResult)
  const claudeSpy = vi
    .spyOn(claudeModule, 'getClaudeSessions')
    .mockImplementation(() => {
      throw new Error('unexpected claude call')
    })

  const result = await runWithFilter('codex')

  expect(result).toEqual(codexResult)
  expect(codexSpy).toHaveBeenCalledTimes(1)
  expect(claudeSpy).not.toHaveBeenCalled()
})

test('returns only claude sessions when claudecode filter is provided', async () => {
  const claudeSession = makeSession(
    'claude-code',
    'claude-1',
    new Date('2024-01-02T12:00:00Z'),
    14,
    2,
  )
  const claudeResult = makeResult([claudeSession])
  const codexSpy = vi
    .spyOn(codexModule, 'getSessions')
    .mockImplementation(() => {
      throw new Error('unexpected codex call')
    })
  const claudeSpy = vi
    .spyOn(claudeModule, 'getClaudeSessions')
    .mockResolvedValue(claudeResult)

  const result = await runWithFilter('claudecode')

  expect(result).toEqual(claudeResult)
  expect(claudeSpy).toHaveBeenCalledTimes(1)
  expect(codexSpy).not.toHaveBeenCalled()
})

test('merges both sources by default', async () => {
  const olderCodex = makeSession(
    'codex',
    'codex-older',
    new Date('2024-01-01T12:00:00Z'),
    8,
    0.5,
  )
  const newerClaude = makeSession(
    'claude-code',
    'claude-newer',
    new Date('2024-01-03T15:00:00Z'),
    16,
    0.75,
  )
  const codexSpy = vi
    .spyOn(codexModule, 'getSessions')
    .mockResolvedValue(makeResult([olderCodex]))
  const claudeSpy = vi
    .spyOn(claudeModule, 'getClaudeSessions')
    .mockResolvedValue(makeResult([newerClaude]))

  const result = await getAllSessions()

  expect(codexSpy).toHaveBeenCalledTimes(1)
  expect(claudeSpy).toHaveBeenCalledTimes(1)
  expect(result.sessions).toEqual([newerClaude, olderCodex])
  expect(result.totalBlendedTokens).toBe(24)
  expect(result.totalCostUsd).toBeCloseTo(1.25)
})
