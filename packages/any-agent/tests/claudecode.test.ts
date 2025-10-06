import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { getClaudeSessions, claudeCodeSessionToUnifiedTranscript } from '../src/claudecode'
import { LiteLLMPricingFetcher } from '../src/pricing'
import type { SessionSummary } from '../src/codex'

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
  expect(session.resumeTarget).toBe('session-1')
  expect(session.source).toBe('claude-code')
  expect(session.path).toBe(transcriptPath)
  expect(session.preview).toBe('Build a feature that parses Claude transcripts')
  expect(session.meta?.summary).toBe('Ship feature summary')
  expect(session.meta?.cwd).toBe('/workspace/test-app')
  expect(session.meta?.resumeSessionId).toBe('session-1')
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

test('getClaudeSessions uses first non-sidechain user message for preview', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-preview-'))
  const claudeDir = path.join(root, '.claude', 'projects')
  const projectId = '-Users-preview-project'
  const projectDir = path.join(claudeDir, projectId)
  await mkdir(projectDir, { recursive: true })

  const timestamp = '2025-04-10T09:30:00.000Z'
  const rootUserUuid = '11111111-2222-3333-4444-555555555555'
  const firstAssistantUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const sidechainUserUuid = '99999999-8888-7777-6666-555555555555'
  const sidechainAssistantUuid = '12121212-3434-5656-7878-909090909090'
  const latestUserUuid = 'fedcba98-7654-3210-0123-456789abcdef'
  const leafUuid = '0f0f0f0f-1a1a-2b2b-3c3c-4d4d4d4d4d4d'

  const lines = [
    JSON.stringify({
      uuid: rootUserUuid,
      type: 'user',
      timestamp,
      message: {
        role: 'user',
        content: 'Start a brand new project',
      },
    }),
    JSON.stringify({
      uuid: firstAssistantUuid,
      type: 'assistant',
      parentUuid: rootUserUuid,
      timestamp,
      message: {
        id: 'assistant-initial',
        role: 'assistant',
      },
    }),
    JSON.stringify({
      uuid: sidechainUserUuid,
      type: 'user',
      parentUuid: firstAssistantUuid,
      timestamp,
      isSidechain: true,
      message: {
        role: 'user',
        content: 'Autop-run instructions',
      },
    }),
    JSON.stringify({
      uuid: sidechainAssistantUuid,
      type: 'assistant',
      parentUuid: sidechainUserUuid,
      timestamp,
      isSidechain: true,
      message: {
        id: 'assistant-sidechain',
        role: 'assistant',
      },
    }),
    JSON.stringify({
      uuid: latestUserUuid,
      type: 'user',
      parentUuid: sidechainAssistantUuid,
      timestamp,
      message: {
        role: 'user',
        content: 'Focus on writing integration tests next',
      },
    }),
    JSON.stringify({
      uuid: leafUuid,
      type: 'assistant',
      parentUuid: latestUserUuid,
      timestamp,
      message: {
        id: 'assistant-leaf',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        usage: {
          input_tokens: 200,
          output_tokens: 150,
        },
      },
    }),
  ]

  const transcriptPath = path.join(projectDir, 'preview.jsonl')
  await writeFile(transcriptPath, `${lines.join('\n')}\n`)

  const { sessions } = await getClaudeSessions({
    claudeDirs: [claudeDir],
  })

  expect(sessions).toHaveLength(1)
  const [session] = sessions
  expect(session.preview).toBe('Start a brand new project')
  expect(session.forkSignature).toBe('Start a brand new project')
})

test('filters meta, status, and tool result user messages from previews', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-meta-'))
  const claudeDir = path.join(root, '.claude', 'projects')
  const projectId = '-Users-meta-project'
  const projectDir = path.join(claudeDir, projectId)
  await mkdir(projectDir, { recursive: true })

  const timestamp = '2025-09-29T22:10:24.389Z'
  const metaUuid = '10000000-0000-4000-8000-000000000001'
  const commandUuid = '20000000-0000-4000-8000-000000000002'
  const stdoutUuid = '30000000-0000-4000-8000-000000000003'
  const primaryUserUuid = '40000000-0000-4000-8000-000000000004'
  const statusUuid = '50000000-0000-4000-8000-000000000005'
  const toolResultUuid = '60000000-0000-4000-8000-000000000006'
  const followUpUuid = '70000000-0000-4000-8000-000000000007'
  const assistantUuid = '80000000-0000-4000-8000-000000000008'

  const lines = [
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      isMeta: true,
      userType: 'external',
      cwd: '/Users/philipp/dev/any-agent',
      sessionId: 'meta-session',
      type: 'user',
      message: {
        role: 'user',
        content:
          'Caveat: The messages below were generated by the user while running local commands. DO NOT respond.',
      },
      uuid: metaUuid,
      timestamp,
    }),
    JSON.stringify({
      parentUuid: metaUuid,
      isSidechain: false,
      userType: 'external',
      cwd: '/Users/philipp/dev/any-agent',
      sessionId: 'meta-session',
      type: 'user',
      message: {
        role: 'user',
        content:
          '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>',
      },
      uuid: commandUuid,
      timestamp,
    }),
    JSON.stringify({
      parentUuid: commandUuid,
      isSidechain: false,
      userType: 'external',
      cwd: '/Users/philipp/dev/any-agent',
      sessionId: 'meta-session',
      type: 'user',
      message: {
        role: 'user',
        content: '<local-command-stdout></local-command-stdout>',
      },
      uuid: stdoutUuid,
      timestamp,
    }),
    JSON.stringify({
      parentUuid: stdoutUuid,
      isSidechain: false,
      userType: 'external',
      cwd: '/Users/philipp/dev/any-agent',
      sessionId: 'meta-session',
      type: 'user',
      message: {
        role: 'user',
        content: 'Fix the packaging error that breaks npx execution.',
      },
      uuid: primaryUserUuid,
      timestamp,
    }),
    JSON.stringify({
      parentUuid: primaryUserUuid,
      isSidechain: false,
      userType: 'external',
      cwd: '/Users/philipp/dev/any-agent',
      sessionId: 'meta-session',
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user]' }],
      },
      uuid: statusUuid,
      timestamp,
    }),
    JSON.stringify({
      parentUuid: statusUuid,
      isSidechain: false,
      userType: 'external',
      cwd: '/Users/philipp/dev/any-agent',
      sessionId: 'meta-session',
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: 'toolu_meta',
            type: 'tool_result',
            content: 'The file /Users/philipp/dev/any-agent/LICENSE has been created.',
          },
        ],
      },
      toolUseResult: {
        type: 'create',
        filePath: '/Users/philipp/dev/any-agent/LICENSE',
      },
      uuid: toolResultUuid,
      timestamp,
    }),
    JSON.stringify({
      parentUuid: toolResultUuid,
      isSidechain: false,
      userType: 'external',
      cwd: '/Users/philipp/dev/any-agent',
      sessionId: 'meta-session',
      type: 'user',
      message: {
        role: 'user',
        content: 'Also ensure the CLI resume script resolves correctly.',
      },
      uuid: followUpUuid,
      timestamp,
    }),
    JSON.stringify({
      parentUuid: followUpUuid,
      isSidechain: false,
      type: 'assistant',
      uuid: assistantUuid,
      timestamp,
      message: {
        id: assistantUuid,
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        usage: {
          input_tokens: 150,
          output_tokens: 120,
        },
      },
    }),
  ]

  const transcriptPath = path.join(projectDir, 'meta.jsonl')
  await writeFile(transcriptPath, `${lines.join('\n')}\n`)

  const pricingFetcher = new LiteLLMPricingFetcher({
    offline: true,
    offlineLoader: async () => ({
      'claude-sonnet-4-5-20250929': {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1e-5,
      },
    }),
  })

  const { sessions } = await getClaudeSessions({
    claudeDirs: [claudeDir],
    pricingFetcher,
  })

  expect(sessions).toHaveLength(1)
  const [session] = sessions
  expect(session.preview).toBe('Fix the packaging error that breaks npx execution.')
  expect(session.forkSignature).toBe('Fix the packaging error that breaks npx execution.')
})

test('ignores shell command output user messages when choosing preview', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-shell-'))
  const claudeDir = path.join(root, '.claude', 'projects')
  const projectId = '-Users-shell-project'
  const projectDir = path.join(claudeDir, projectId)
  await mkdir(projectDir, { recursive: true })

  const timestamp = '2025-09-29T22:10:21.053Z'
  const userPromptUuid = '11111111-1111-1111-1111-111111111111'
  const assistantFirstUuid = '22222222-2222-2222-2222-222222222222'
  const shellOutputUuid = '33333333-3333-3333-3333-333333333333'
  const assistantLeafUuid = '44444444-4444-4444-4444-444444444444'

  const lines = [
    JSON.stringify({
      uuid: userPromptUuid,
      type: 'user',
      timestamp,
      message: {
        role: 'user',
        content: 'Investigate npx install failure quickly',
      },
    }),
    JSON.stringify({
      uuid: assistantFirstUuid,
      type: 'assistant',
      parentUuid: userPromptUuid,
      timestamp,
      message: {
        id: 'assistant-initial',
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        usage: {
          input_tokens: 120,
          output_tokens: 80,
        },
      },
    }),
    JSON.stringify({
      uuid: shellOutputUuid,
      type: 'user',
      parentUuid: assistantFirstUuid,
      timestamp,
      message: {
        role: 'user',
        content: 'α philipp/dev npx -y any-agent@latest\nnpm error code ETARGET\nnpm error notarget No matching version found for any-agent@0.1.2.\nα philipp/dev',
      },
    }),
    JSON.stringify({
      uuid: assistantLeafUuid,
      type: 'assistant',
      parentUuid: shellOutputUuid,
      timestamp,
      message: {
        id: 'assistant-leaf',
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        usage: {
          input_tokens: 150,
          output_tokens: 110,
        },
      },
    }),
  ]

  const transcriptPath = path.join(projectDir, 'shell.jsonl')
  await writeFile(transcriptPath, `${lines.join('\n')}\n`)

  const pricingFetcher = new LiteLLMPricingFetcher({
    offline: true,
    offlineLoader: async () => ({
      'claude-sonnet-4-5-20250929': {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1e-5,
      },
    }),
  })

  const { sessions } = await getClaudeSessions({
    claudeDirs: [claudeDir],
    pricingFetcher,
  })

  expect(sessions).toHaveLength(1)
  const [session] = sessions
  expect(session.preview).toBe('Investigate npx install failure quickly')
  expect(session.forkSignature).toBe('Investigate npx install failure quickly')
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

describe('claudeCodeSessionToUnifiedTranscript', () => {
  test('converts user messages', () => {
    const session: SessionSummary = {
      id: 'test-claude-1',
      source: 'claude-code',
      path: '/test/path.jsonl',
      resumeTarget: 'session-id-1',
      timestamp: new Date('2025-10-02T22:08:46.264Z'),
      timestampUtc: '2025-10-02T22:08:46.264Z',
      relativeTime: '14 minutes ago',
      preview: 'The current ctrl+enter feature',
      meta: null,
      head: [
        {
          uuid: 'uuid-1',
          type: 'user',
          message: {
            role: 'user',
            content: 'The current ctrl+enter feature: make it store the transcript',
          },
          raw: {
            type: 'user',
            message: {
              role: 'user',
              content: 'The current ctrl+enter feature: make it store the transcript',
            },
          },
        },
      ],
      tokenUsage: {
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 200,
        reasoningOutputTokens: 0,
        totalTokens: 1200,
      },
      blendedTokens: 700,
      isFork: false,
      branchMarker: ' ',
      forkSignature: null,
      model: 'claude-sonnet-4-5-20250929',
      costUsd: 0.092,
      modelUsage: new Map(),
      messageCount: 1,
    }

    const result = claudeCodeSessionToUnifiedTranscript(session)

    expect(result.v).toBe(1)
    expect(result.source).toBe('claude-code')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({
      role: 'user',
      text: 'The current ctrl+enter feature: make it store the transcript',
    })
  })

  test('converts assistant text responses', () => {
    const session: SessionSummary = {
      id: 'test-claude-2',
      source: 'claude-code',
      path: '/test/path.jsonl',
      resumeTarget: 'session-id-2',
      timestamp: new Date('2025-10-02T22:08:46.264Z'),
      timestampUtc: '2025-10-02T22:08:46.264Z',
      relativeTime: '14 minutes ago',
      preview: 'Test text',
      meta: null,
      head: [
        {
          uuid: 'uuid-2',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: "I'll help you update the transcript upload feature.",
              },
            ],
          },
          raw: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: "I'll help you update the transcript upload feature.",
                },
              ],
            },
          },
        },
      ],
      tokenUsage: {
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 200,
        reasoningOutputTokens: 0,
        totalTokens: 1200,
      },
      blendedTokens: 700,
      isFork: false,
      branchMarker: ' ',
      forkSignature: null,
      model: 'claude-sonnet-4-5-20250929',
      costUsd: 0.092,
      modelUsage: new Map(),
      messageCount: 1,
    }

    const result = claudeCodeSessionToUnifiedTranscript(session)

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      text: "I'll help you update the transcript upload feature.",
    })
  })

  test('converts Read tool calls with results', () => {
    const session: SessionSummary = {
      id: 'test-claude-3',
      source: 'claude-code',
      path: '/test/path.jsonl',
      resumeTarget: 'session-id-3',
      timestamp: new Date('2025-10-02T22:08:46.264Z'),
      timestampUtc: '2025-10-02T22:08:46.264Z',
      relativeTime: '14 minutes ago',
      preview: 'Test read',
      meta: null,
      head: [
        {
          uuid: 'uuid-3',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_test',
                name: 'Read',
                input: {
                  file_path: '/test/file.ts',
                  offset: 0,
                  limit: 100,
                },
              },
            ],
          },
          raw: {
            type: 'assistant',
          },
        },
        {
          uuid: 'uuid-4',
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_test',
                content: '1→export const test = true\n2→',
              },
            ],
          },
          raw: {
            type: 'user',
          },
        },
      ],
      tokenUsage: {
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 200,
        reasoningOutputTokens: 0,
        totalTokens: 1200,
      },
      blendedTokens: 700,
      isFork: false,
      branchMarker: ' ',
      forkSignature: null,
      model: 'claude-sonnet-4-5-20250929',
      costUsd: 0.092,
      modelUsage: new Map(),
      messageCount: 2,
    }

    const result = claudeCodeSessionToUnifiedTranscript(session)

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({
      role: 'assistant',
      call: {
        tool: 'ClaudeCodeRead',
        file: '/test/file.ts',
      },
    })
    expect((result.messages[0] as any).call.lines).toContain('export const test = true')
  })

  test('converts Edit tool calls', () => {
    const session: SessionSummary = {
      id: 'test-claude-4',
      source: 'claude-code',
      path: '/test/path.jsonl',
      resumeTarget: 'session-id-4',
      timestamp: new Date('2025-10-02T22:08:46.264Z'),
      timestampUtc: '2025-10-02T22:08:46.264Z',
      relativeTime: '14 minutes ago',
      preview: 'Test edit',
      meta: null,
      head: [
        {
          uuid: 'uuid-5',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_edit',
                name: 'Edit',
                input: {
                  file_path: '/test/file.ts',
                  old_string: 'const x = 1',
                  new_string: 'const x = 2',
                },
              },
            ],
          },
          raw: {
            type: 'assistant',
          },
        },
      ],
      tokenUsage: {
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 200,
        reasoningOutputTokens: 0,
        totalTokens: 1200,
      },
      blendedTokens: 700,
      isFork: false,
      branchMarker: ' ',
      forkSignature: null,
      model: 'claude-sonnet-4-5-20250929',
      costUsd: 0.092,
      modelUsage: new Map(),
      messageCount: 1,
    }

    const result = claudeCodeSessionToUnifiedTranscript(session)

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      call: {
        tool: 'ClaudeCodeEdit',
        file: '/test/file.ts',
        diff: '- const x = 1\n+ const x = 2',
      },
    })
  })

  test('converts Bash tool calls with output', () => {
    const session: SessionSummary = {
      id: 'test-claude-5',
      source: 'claude-code',
      path: '/test/path.jsonl',
      resumeTarget: 'session-id-5',
      timestamp: new Date('2025-10-02T22:08:46.264Z'),
      timestampUtc: '2025-10-02T22:08:46.264Z',
      relativeTime: '14 minutes ago',
      preview: 'Test bash',
      meta: null,
      head: [
        {
          uuid: 'uuid-6',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_bash',
                name: 'Bash',
                input: {
                  command: 'ls -la',
                },
              },
            ],
          },
          raw: {
            type: 'assistant',
          },
        },
        {
          uuid: 'uuid-7',
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_bash',
                content: 'total 8\ndrwxr-xr-x  2 user  staff  64 Oct  2 22:08 .',
              },
            ],
          },
          raw: {
            type: 'user',
          },
        },
      ],
      tokenUsage: {
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 200,
        reasoningOutputTokens: 0,
        totalTokens: 1200,
      },
      blendedTokens: 700,
      isFork: false,
      branchMarker: ' ',
      forkSignature: null,
      model: 'claude-sonnet-4-5-20250929',
      costUsd: 0.092,
      modelUsage: new Map(),
      messageCount: 2,
    }

    const result = claudeCodeSessionToUnifiedTranscript(session)

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      call: {
        tool: 'ClaudeCodeBash',
        command: 'ls -la',
        output: 'total 8\ndrwxr-xr-x  2 user  staff  64 Oct  2 22:08 .',
      },
    })
  })

  test('converts unknown tools', () => {
    const session: SessionSummary = {
      id: 'test-claude-6',
      source: 'claude-code',
      path: '/test/path.jsonl',
      resumeTarget: 'session-id-6',
      timestamp: new Date('2025-10-02T22:08:46.264Z'),
      timestampUtc: '2025-10-02T22:08:46.264Z',
      relativeTime: '14 minutes ago',
      preview: 'Test unknown',
      meta: null,
      head: [
        {
          uuid: 'uuid-8',
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_unknown',
                name: 'FutureTool',
                input: {
                  param1: 'value1',
                  param2: 42,
                },
              },
            ],
          },
          raw: {
            type: 'assistant',
          },
        },
        {
          uuid: 'uuid-9',
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_unknown',
                content: 'Result from future tool',
              },
            ],
          },
          raw: {
            type: 'user',
          },
        },
      ],
      tokenUsage: {
        inputTokens: 1000,
        cachedInputTokens: 500,
        outputTokens: 200,
        reasoningOutputTokens: 0,
        totalTokens: 1200,
      },
      blendedTokens: 700,
      isFork: false,
      branchMarker: ' ',
      forkSignature: null,
      model: 'claude-sonnet-4-5-20250929',
      costUsd: 0.092,
      modelUsage: new Map(),
      messageCount: 2,
    }

    const result = claudeCodeSessionToUnifiedTranscript(session)

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      call: {
        tool: 'Unknown',
        name: 'FutureTool',
        input: {
          param1: 'value1',
          param2: 42,
        },
        output: 'Result from future tool',
      },
    })
  })
})
