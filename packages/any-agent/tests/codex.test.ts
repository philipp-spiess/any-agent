import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { getSessions, codexSessionToUnifiedTranscript } from '../src/codex'
import { LiteLLMPricingFetcher } from '../src/pricing'
import type { SessionSummary } from '../src/codex'

const fixtureHome = fileURLToPath(new URL('./fixtures/codex-home', import.meta.url))

test('getSessions reads fixture sessions and marks forks with pricing data', async () => {
  const pricingFetcher = new LiteLLMPricingFetcher({
    offline: true,
    offlineLoader: async () => ({
      'gpt-5-codex': {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
        cache_read_input_token_cost: 5e-7,
      },
      'gpt-4.1-mini': {
        input_cost_per_token: 2e-6,
        output_cost_per_token: 3e-6,
      },
    }),
  })

  const { sessions, totalBlendedTokens, totalCostUsd } = await getSessions({
    codexHome: fixtureHome,
    pricingFetcher,
  })

  expect(sessions).toHaveLength(2)

  const [newer, older] = sessions

  expect(newer.id).toBe('22222222-2222-4222-8222-222222222222')
  expect(newer.branchMarker).toBe('┌')
  expect(newer.isFork).toBe(true)
  expect(newer.preview).toBe('Build me a web app')
  expect(newer.forkSignature).toBe('Build me a web app')
  expect(newer.model).toBe('gpt-4.1-mini')
  expect(newer.tokenUsage).toEqual({
    inputTokens: 1000,
    cachedInputTokens: 0,
    outputTokens: 900,
    reasoningOutputTokens: 100,
    totalTokens: 2000,
  })
  expect(newer.modelUsage.get('gpt-4.1-mini')).toEqual({
    inputTokens: 1000,
    cachedInputTokens: 0,
    outputTokens: 900,
    reasoningOutputTokens: 100,
    totalTokens: 2000,
  })
  expect(newer.costUsd).toBeCloseTo(0.0047)

  expect(older.id).toBe('11111111-1111-4111-8111-111111111111')
  expect(older.branchMarker).toBe('┴')
  expect(older.isFork).toBe(false)
  expect(older.meta?.instructions).toBeNull()
  expect(older.meta?.originator).toBe('tester')
  expect(older.model).toBe('gpt-5-codex')
  expect(older.tokenUsage).toEqual({
    inputTokens: 600,
    cachedInputTokens: 100,
    outputTokens: 400,
    reasoningOutputTokens: 0,
    totalTokens: 1000,
  })
  expect(older.modelUsage.get('gpt-5-codex')).toEqual({
    inputTokens: 600,
    cachedInputTokens: 100,
    outputTokens: 400,
    reasoningOutputTokens: 0,
    totalTokens: 1000,
  })
  expect(older.costUsd).toBeCloseTo(0.00135)

  expect(totalBlendedTokens).toBe(2900)
  expect(totalCostUsd).toBeCloseTo(0.00605)
})

describe('codexSessionToUnifiedTranscript', () => {
  test('converts user messages', () => {
    const session: SessionSummary = {
      id: 'test-codex-1',
      source: 'codex',
      path: '/test/path',
      resumeTarget: 'test-codex-1',
      timestamp: new Date('2025-10-02T22:21:16.000Z'),
      timestampUtc: '2025-10-02T22:21:16.000Z',
      relativeTime: '10 minutes ago',
      preview: 'Write "hello" into the README',
      meta: null,
      head: [
        {
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'Write "hello" into the README',
            kind: 'plain',
          },
        },
      ],
      tokenUsage: {
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 200,
        reasoningOutputTokens: 100,
        totalTokens: 1300,
      },
      blendedTokens: 800,
      isFork: false,
      branchMarker: ' ',
      forkSignature: null,
      model: 'gpt-5-codex',
      costUsd: 0.05,
      modelUsage: new Map(),
      messageCount: 1,
    }

    const result = codexSessionToUnifiedTranscript(session)

    expect(result.v).toBe(1)
    expect(result.source).toBe('codex')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({
      role: 'user',
      text: 'Write "hello" into the README',
    })
  })

  test('converts agent reasoning', () => {
    const session: SessionSummary = {
      id: 'test-codex-2',
      source: 'codex',
      path: '/test/path',
      resumeTarget: 'test-codex-2',
      timestamp: new Date('2025-10-02T22:21:16.000Z'),
      timestampUtc: '2025-10-02T22:21:16.000Z',
      relativeTime: '10 minutes ago',
      preview: 'Test reasoning',
      meta: null,
      head: [
        {
          type: 'event_msg',
          payload: {
            type: 'agent_reasoning',
            text: '**Determining how to add "hello" to README**',
          },
        },
      ],
      tokenUsage: {
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 200,
        reasoningOutputTokens: 100,
        totalTokens: 1300,
      },
      blendedTokens: 800,
      isFork: false,
      branchMarker: ' ',
      forkSignature: null,
      model: 'gpt-5-codex',
      costUsd: 0.05,
      modelUsage: new Map(),
      messageCount: 1,
    }

    const result = codexSessionToUnifiedTranscript(session)

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      thinking: '**Determining how to add "hello" to README**',
    })
  })

  test('converts agent text responses', () => {
    const session: SessionSummary = {
      id: 'test-codex-3',
      source: 'codex',
      path: '/test/path',
      resumeTarget: 'test-codex-3',
      timestamp: new Date('2025-10-02T22:21:16.000Z'),
      timestampUtc: '2025-10-02T22:21:16.000Z',
      relativeTime: '10 minutes ago',
      preview: 'Test response',
      meta: null,
      head: [
        {
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: 'Added a closing hello line to the project docs in `README.md:19`.',
          },
        },
      ],
      tokenUsage: {
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 200,
        reasoningOutputTokens: 100,
        totalTokens: 1300,
      },
      blendedTokens: 800,
      isFork: false,
      branchMarker: ' ',
      forkSignature: null,
      model: 'gpt-5-codex',
      costUsd: 0.05,
      modelUsage: new Map(),
      messageCount: 1,
    }

    const result = codexSessionToUnifiedTranscript(session)

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      text: 'Added a closing hello line to the project docs in `README.md:19`.',
    })
  })

  test('converts shell function calls with outputs', () => {
    const session: SessionSummary = {
      id: 'test-codex-4',
      source: 'codex',
      path: '/test/path',
      resumeTarget: 'test-codex-4',
      timestamp: new Date('2025-10-02T22:21:16.000Z'),
      timestampUtc: '2025-10-02T22:21:16.000Z',
      relativeTime: '10 minutes ago',
      preview: 'Test shell',
      meta: null,
      head: [
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell',
            arguments: '{"command":["bash","-lc","ls -1"],"workdir":"/Users/philipp/dev/any-agent"}',
            call_id: 'call_test',
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call_test',
            output: '{"output":"README.md\\npackage.json\\n","metadata":{"exit_code":0,"duration_seconds":0.0}}',
          },
        },
      ],
      tokenUsage: {
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 200,
        reasoningOutputTokens: 100,
        totalTokens: 1300,
      },
      blendedTokens: 800,
      isFork: false,
      branchMarker: ' ',
      forkSignature: null,
      model: 'gpt-5-codex',
      costUsd: 0.05,
      modelUsage: new Map(),
      messageCount: 2,
    }

    const result = codexSessionToUnifiedTranscript(session)

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      call: {
        tool: 'CodexShell',
        command: 'bash -lc ls -1',
        output: 'README.md\npackage.json\n',
        exit_code: 0,
      },
    })
  })
})
