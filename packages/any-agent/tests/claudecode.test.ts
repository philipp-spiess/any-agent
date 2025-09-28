import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { getClaudeSessions } from '../src/claudecode'
import { LiteLLMPricingFetcher } from '../src/pricing'

test('getClaudeSessions returns empty array when Claude directories are missing', async () => {
  const missingDir = path.join(os.tmpdir(), 'claude-non-existent')
  const { sessions, totalBlendedTokens, totalCostUsd } = await getClaudeSessions({
    claudeDirs: [missingDir],
  })
  expect(sessions).toEqual([])
  expect(totalBlendedTokens).toBe(0)
  expect(totalCostUsd).toBe(0)
})

test('getClaudeSessions reads transcript files and returns session summaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-transcripts-'))
  const claudeDir = path.join(root, '.claude', 'projects')
  const projectId = '-Users-test-project'
  const projectDir = path.join(claudeDir, projectId)
  await mkdir(projectDir, { recursive: true })

  const timestamp = '2025-01-03T12:00:00.000Z'
  const leafUuid = '11111111-2222-3333-4444-555555555555'
  const userUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  const lines = [
    JSON.stringify({
      type: 'summary',
      leafUuid,
      summary: 'Ship feature summary',
    }),
    JSON.stringify({
      uuid: userUuid,
      type: 'user',
      timestamp,
      sessionId: 'session-1',
      cwd: '/workspace/test-app',
      message: {
        role: 'user',
        content: 'Build a feature that parses Claude transcripts',
      },
    }),
    JSON.stringify({
      uuid: leafUuid,
      type: 'assistant',
      parentUuid: userUuid,
      timestamp,
      message: {
        id: leafUuid,
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        content: [],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 400,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 50,
          output_tokens: 350,
        },
      },
    }),
  ]

  const transcriptPath = path.join(projectDir, 'transcript.jsonl')
  await writeFile(transcriptPath, `${lines.join('\n')}\n`)

  const pricingFetcher = new LiteLLMPricingFetcher({
    offline: true,
    offlineLoader: async () => ({
      'claude-3-5-sonnet-20241022': {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1e-5,
        cache_read_input_token_cost: 1e-6,
      },
    }),
  })

  const { sessions, totalBlendedTokens, totalCostUsd } = await getClaudeSessions({
    claudeDirs: [claudeDir],
    pricingFetcher,
  })

  expect(sessions).toHaveLength(1)
  const [session] = sessions
  expect(session.id).toBe(leafUuid)
  expect(session.source).toBe('claude-code')
  expect(session.path).toBe(transcriptPath)
  expect(session.preview).toBe('Build a feature that parses Claude transcripts')
  expect(session.meta?.summary).toBe('Ship feature summary')
  expect(session.meta?.cwd).toBe('/workspace/test-app')
  expect(session.meta?.projectPath).toBe(path.join(path.sep, 'Users', 'test', 'project'))
  expect(session.tokenUsage).toEqual({
    inputTokens: 460,
    cachedInputTokens: 50,
    outputTokens: 350,
    reasoningOutputTokens: 0,
    totalTokens: 810,
  })
  expect(session.blendedTokens).toBe(760)
  expect(session.model).toBe('claude-3-5-sonnet-20241022')
  expect(session.modelUsage.get('claude-3-5-sonnet-20241022')).toEqual({
    inputTokens: 460,
    cachedInputTokens: 50,
    outputTokens: 350,
    reasoningOutputTokens: 0,
    totalTokens: 810,
  })
  expect(session.costUsd).toBeCloseTo(0.00475, 5)
  expect(totalBlendedTokens).toBe(760)
  expect(totalCostUsd).toBeCloseTo(0.00475, 5)
})

test('deduplicates repeated assistant events by message id and request id', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-dedupe-'))
  const claudeDir = path.join(root, '.claude', 'projects')
  const projectId = '-Users-dedupe'
  const projectDir = path.join(claudeDir, projectId)
  await mkdir(projectDir, { recursive: true })

  const userUuid = '11111111-2222-3333-4444-555555555555'
  const firstAssistantUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const leafUuid = '99999999-8888-7777-6666-555555555555'
  const timestamp = '2025-02-14T10:00:00.000Z'

  const usage = {
    input_tokens: 100,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 50,
  }

  const lines = [
    JSON.stringify({
      uuid: userUuid,
      type: 'user',
      timestamp,
      message: {
        role: 'user',
        content: 'Plan the deployment steps',
      },
    }),
    JSON.stringify({
      uuid: firstAssistantUuid,
      type: 'assistant',
      parentUuid: userUuid,
      timestamp,
      requestId: 'req-123',
      message: {
        id: 'msg-123',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        usage,
      },
    }),
    JSON.stringify({
      uuid: leafUuid,
      type: 'assistant',
      parentUuid: firstAssistantUuid,
      timestamp,
      requestId: 'req-123',
      message: {
        id: 'msg-123',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        usage,
      },
    }),
  ]

  await writeFile(path.join(projectDir, 'dedupe.jsonl'), `${lines.join('\n')}\n`)

  const pricingFetcher = new LiteLLMPricingFetcher({
    offline: true,
    offlineLoader: async () => ({
      'claude-3-5-sonnet-20241022': {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1e-5,
      },
    }),
  })

  const { sessions, totalCostUsd } = await getClaudeSessions({
    claudeDirs: [claudeDir],
    pricingFetcher,
  })

  expect(sessions).toHaveLength(1)
  const [session] = sessions
  expect(session.tokenUsage).toEqual({
    inputTokens: 100,
    cachedInputTokens: 0,
    outputTokens: 50,
    reasoningOutputTokens: 0,
    totalTokens: 150,
  })
  expect(session.costUsd).toBeCloseTo(0.0008, 6)
  expect(totalCostUsd).toBeCloseTo(0.0008, 6)
})

test('skips sessions without any token usage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-empty-'))
  const claudeDir = path.join(root, '.claude', 'projects')
  const projectDir = path.join(claudeDir, '-Users-empty')
  await mkdir(projectDir, { recursive: true })

  const lines = [
    JSON.stringify({
      uuid: 'user-empty',
      type: 'user',
      timestamp: '2025-03-01T08:00:00.000Z',
      message: {
        role: 'user',
        content: 'Say hello',
      },
    }),
    JSON.stringify({
      uuid: 'assistant-empty',
      parentUuid: 'user-empty',
      type: 'assistant',
      timestamp: '2025-03-01T08:00:05.000Z',
      requestId: 'req-empty',
      message: {
        id: 'msg-empty',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
    }),
  ]

  await writeFile(path.join(projectDir, 'empty.jsonl'), `${lines.join('\n')}\n`)

  const { sessions, totalBlendedTokens, totalCostUsd } = await getClaudeSessions({
    claudeDirs: [claudeDir],
  })

  expect(sessions).toHaveLength(0)
  expect(totalBlendedTokens).toBe(0)
  expect(totalCostUsd).toBe(0)
})

test('marks forked sessions and assigns branch markers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-forks-'))
  const claudeDir = path.join(root, '.claude', 'projects')
  const projectDir = path.join(claudeDir, '-Users-forks')
  await mkdir(projectDir, { recursive: true })

  const userUuid = 'user-fork'
  const baseAssistantUuid = 'assistant-base'
  const forkAssistantUuid = 'assistant-fork'

  const lines = [
    JSON.stringify({
      uuid: userUuid,
      type: 'user',
      timestamp: '2025-04-10T09:00:00.000Z',
      message: {
        role: 'user',
        content: 'Branching request',
      },
    }),
    JSON.stringify({
      uuid: baseAssistantUuid,
      parentUuid: userUuid,
      type: 'assistant',
      timestamp: '2025-04-10T09:01:00.000Z',
      requestId: 'req-base',
      message: {
        id: 'msg-base',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        usage: {
          input_tokens: 120,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 0,
          output_tokens: 40,
        },
      },
    }),
    JSON.stringify({
      uuid: forkAssistantUuid,
      parentUuid: userUuid,
      type: 'assistant',
      timestamp: '2025-04-10T09:05:00.000Z',
      requestId: 'req-fork',
      message: {
        id: 'msg-fork',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        usage: {
          input_tokens: 80,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 50,
          output_tokens: 30,
        },
      },
    }),
  ]

  await writeFile(path.join(projectDir, 'forks.jsonl'), `${lines.join('\n')}\n`)

  const pricingFetcher = new LiteLLMPricingFetcher({
    offline: true,
    offlineLoader: async () => ({
      'claude-3-5-sonnet-20241022': {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1e-5,
        cache_read_input_token_cost: 1e-6,
      },
    }),
  })

  const { sessions } = await getClaudeSessions({
    claudeDirs: [claudeDir],
    pricingFetcher,
  })

  expect(sessions).toHaveLength(2)
  const [latest, base] = sessions

  expect(latest.isFork).toBe(true)
  expect(latest.branchMarker).toBe('┌')
  expect(base.isFork).toBe(false)
  expect(base.branchMarker).toBe('┴')

  expect(base.tokenUsage).toEqual({
    inputTokens: 130,
    cachedInputTokens: 0,
    outputTokens: 40,
    reasoningOutputTokens: 0,
    totalTokens: 170,
  })
  expect(latest.tokenUsage).toEqual({
    inputTokens: 130,
    cachedInputTokens: 50,
    outputTokens: 30,
    reasoningOutputTokens: 0,
    totalTokens: 160,
  })
})
