import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { getSessions } from '../src/codex'
import { LiteLLMPricingFetcher } from '../src/pricing'

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
