import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { getSessions } from '../src'
import { LiteLLMPricingFetcher } from '../src/pricing'

test('getSessions returns empty array when sessions directory is missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-sessions-empty-'))
  const pricingFetcher = new LiteLLMPricingFetcher({
    offline: true,
    offlineLoader: async () => ({}),
  })
  const { sessions, totalBlendedTokens, totalCostUsd } = await getSessions({
    codexHome: root,
    pricingFetcher,
  })
  expect(sessions).toEqual([])
  expect(totalBlendedTokens).toBe(0)
  expect(totalCostUsd).toBe(0)
})

test('getSessions reads rollout files and returns session summaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-sessions-'))
  const date = '2025-01-03T12-00-00'
  const id = '53b92776-fd64-465f-a02d-b305917809fe'
  const sessionDir = path.join(root, 'sessions', '2025', '01', '03')
  await mkdir(sessionDir, { recursive: true })

  const contents = [
    JSON.stringify({
      timestamp: date,
      type: 'session_meta',
      payload: {
        id,
        timestamp: date,
        instructions: null,
        cwd: '.',
        originator: 'test_originator',
        cli_version: 'test_version',
      },
    }),
    JSON.stringify({
      timestamp: date,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Hello from user',
        kind: 'plain',
      },
    }),
    JSON.stringify({
      timestamp: date,
      type: 'turn_context',
      payload: {
        model: 'gpt-5-codex',
      },
    }),
    JSON.stringify({
      timestamp: date,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1200,
            cached_input_tokens: 200,
            output_tokens: 800,
            reasoning_output_tokens: 100,
            total_tokens: 2200,
          },
        },
      },
    }),
    JSON.stringify({ record_type: 'response', index: 0 }),
  ].join('\n')

  const filePath = path.join(sessionDir, `rollout-${date}-${id}.jsonl`)
  await writeFile(filePath, `${contents}\n`)

  const pricingFetcher = new LiteLLMPricingFetcher({
    offline: true,
    offlineLoader: async () => ({
      'gpt-5-codex': {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
        cache_read_input_token_cost: 5e-7,
      },
    }),
  })

  const { sessions, totalBlendedTokens, totalCostUsd } = await getSessions({
    codexHome: root,
    pricingFetcher,
  })
  expect(sessions).toHaveLength(1)

  const [session] = sessions
  expect(session.id).toBe(id)
  expect(session.path).toBe(filePath)
  expect(session.preview).toBe('Hello from user')
  expect(session.meta?.originator).toBe('test_originator')
  const expectedDate = new Date(2025, 0, 3, 12, 0, 0)
  expect(session.timestampUtc).toBe(expectedDate.toISOString())
  expect(session.tokenUsage).toEqual({
    inputTokens: 1200,
    cachedInputTokens: 200,
    outputTokens: 800,
    reasoningOutputTokens: 100,
    totalTokens: 2200,
  })
  expect(session.blendedTokens).toBe(1900)
  expect(session.isFork).toBe(false)
  expect(session.branchMarker).toBe(' ')
  expect(session.forkSignature).toBe('Hello from user')
  expect(session.model).toBe('gpt-5-codex')
  expect(session.costUsd).toBeCloseTo(0.0027)
  expect(session.messageCount).toBe(1)
  expect(totalBlendedTokens).toBe(1900)
  expect(totalCostUsd).toBeCloseTo(0.0027)
})
