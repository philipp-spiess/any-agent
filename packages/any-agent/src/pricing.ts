import * as v from 'valibot'

type JsonRecord = Record<string, unknown>

export const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

const DEFAULT_TIERED_THRESHOLD = 200_000

const liteLLMModelPricingSchema = v.object({
  input_cost_per_token: v.optional(v.number()),
  output_cost_per_token: v.optional(v.number()),
  cache_creation_input_token_cost: v.optional(v.number()),
  cache_read_input_token_cost: v.optional(v.number()),
  max_tokens: v.optional(v.number()),
  max_input_tokens: v.optional(v.number()),
  max_output_tokens: v.optional(v.number()),
  input_cost_per_token_above_200k_tokens: v.optional(v.number()),
  output_cost_per_token_above_200k_tokens: v.optional(v.number()),
  cache_creation_input_token_cost_above_200k_tokens: v.optional(v.number()),
  cache_read_input_token_cost_above_200k_tokens: v.optional(v.number()),
  input_cost_per_token_above_128k_tokens: v.optional(v.number()),
  output_cost_per_token_above_128k_tokens: v.optional(v.number()),
})

export type LiteLLMModelPricing = v.InferOutput<typeof liteLLMModelPricingSchema>

export type PricingLogger = {
  debug: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

export type LiteLLMPricingFetcherOptions = {
  logger?: PricingLogger
  offline?: boolean
  offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>
  url?: string
  providerPrefixes?: string[]
}

const DEFAULT_PROVIDER_PREFIXES = [
  'anthropic/',
  'claude-3-5-',
  'claude-3-',
  'claude-',
  'openai/',
  'azure/',
  'openrouter/openai/',
]

function createLogger(logger?: PricingLogger): PricingLogger {
  if (logger != null) {
    return logger
  }

  return {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  }
}

export class LiteLLMPricingFetcher {
  private cachedPricing: Map<string, LiteLLMModelPricing> | null = null

  private readonly logger: PricingLogger

  private readonly offline: boolean

  private readonly offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>

  private readonly url: string

  private readonly providerPrefixes: string[]

  constructor(options: LiteLLMPricingFetcherOptions = {}) {
    this.logger = createLogger(options.logger)
    this.offline = Boolean(options.offline)
    this.offlineLoader = options.offlineLoader
    this.url = options.url ?? LITELLM_PRICING_URL
    this.providerPrefixes = options.providerPrefixes ?? DEFAULT_PROVIDER_PREFIXES
  }

  [Symbol.dispose]() {
    this.clearCache()
  }

  clearCache(): void {
    this.cachedPricing = null
  }

  private async loadOfflinePricing(): Promise<Map<string, LiteLLMModelPricing>> {
    if (this.offlineLoader == null) {
      throw new Error('Offline loader was not provided')
    }

    const pricing = new Map(Object.entries(await this.offlineLoader()))
    this.cachedPricing = pricing
    return pricing
  }

  private async fetchRemotePricing(): Promise<Map<string, LiteLLMModelPricing>> {
    this.logger.warn('Fetching latest model pricing from LiteLLM...')
    const response = await fetch(this.url)
    if (!response.ok) {
      throw new Error(`Failed to fetch pricing data: ${response.statusText}`)
    }

    const raw = (await response.json()) as JsonRecord
    const pricing = new Map<string, LiteLLMModelPricing>()
    for (const [modelName, modelData] of Object.entries(raw)) {
      if (typeof modelData !== 'object' || modelData == null) {
        continue
      }
      const parsed = v.safeParse(liteLLMModelPricingSchema, modelData)
      if (!parsed.success) {
        continue
      }
      pricing.set(modelName, parsed.output)
    }
    this.cachedPricing = pricing
    this.logger.info(`Loaded pricing for ${pricing.size} models`)
    return pricing
  }

  private async ensurePricingLoaded(): Promise<Map<string, LiteLLMModelPricing>> {
    if (this.cachedPricing != null) {
      return this.cachedPricing
    }

    if (this.offline) {
      return this.loadOfflinePricing()
    }

    try {
      return await this.fetchRemotePricing()
    } catch (error) {
      this.logger.warn('Failed to fetch model pricing from LiteLLM, falling back to offline loader (if available).')
      if (this.offlineLoader != null) {
        return this.loadOfflinePricing()
      }
      throw error
    }
  }

  async fetchModelPricing(): Promise<Map<string, LiteLLMModelPricing>> {
    return this.ensurePricingLoaded()
  }

  private createMatchingCandidates(modelName: string): string[] {
    const candidates = new Set<string>()
    candidates.add(modelName)

    for (const prefix of this.providerPrefixes) {
      candidates.add(`${prefix}${modelName}`)
    }

    return Array.from(candidates)
  }

  async getModelPricing(modelName: string): Promise<LiteLLMModelPricing | null> {
    const pricing = await this.ensurePricingLoaded()

    for (const candidate of this.createMatchingCandidates(modelName)) {
      const direct = pricing.get(candidate)
      if (direct != null) {
        return direct
      }
    }

    const lower = modelName.toLowerCase()
    for (const [key, value] of pricing) {
      const comparison = key.toLowerCase()
      if (comparison.includes(lower) || lower.includes(comparison)) {
        return value
      }
    }

    return null
  }

  async getModelContextLimit(modelName: string): Promise<number | null> {
    const pricing = await this.getModelPricing(modelName)
    return pricing?.max_input_tokens ?? null
  }

  calculateCostFromPricing(
    tokens: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    },
    pricing: LiteLLMModelPricing,
  ): number {
    const calculateTieredCost = (
      totalTokens: number | undefined,
      basePrice: number | undefined,
      tieredPrice: number | undefined,
      threshold: number = DEFAULT_TIERED_THRESHOLD,
    ) => {
      if (totalTokens == null || totalTokens <= 0) {
        return 0
      }

      if (totalTokens > threshold && tieredPrice != null) {
        const tokensBelowThreshold = Math.min(totalTokens, threshold)
        const tokensAboveThreshold = Math.max(0, totalTokens - threshold)

        let tieredCost = tokensAboveThreshold * tieredPrice
        if (basePrice != null) {
          tieredCost += tokensBelowThreshold * basePrice
        }
        return tieredCost
      }

      if (basePrice != null) {
        return totalTokens * basePrice
      }

      return 0
    }

    const inputCost = calculateTieredCost(
      tokens.input_tokens,
      pricing.input_cost_per_token,
      pricing.input_cost_per_token_above_200k_tokens,
    )

    const outputCost = calculateTieredCost(
      tokens.output_tokens,
      pricing.output_cost_per_token,
      pricing.output_cost_per_token_above_200k_tokens,
    )

    const cacheCreationCost = calculateTieredCost(
      tokens.cache_creation_input_tokens,
      pricing.cache_creation_input_token_cost,
      pricing.cache_creation_input_token_cost_above_200k_tokens,
    )

    const cacheReadCost = calculateTieredCost(
      tokens.cache_read_input_tokens,
      pricing.cache_read_input_token_cost,
      pricing.cache_read_input_token_cost_above_200k_tokens,
    )

    return inputCost + outputCost + cacheCreationCost + cacheReadCost
  }

  async calculateCostFromTokens(
    tokens: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    },
    modelName?: string,
  ): Promise<number> {
    if (modelName == null || modelName === '') {
      return 0
    }

    const pricing = await this.getModelPricing(modelName)
    if (pricing == null) {
      throw new Error(`Model pricing not found for ${modelName}`)
    }

    return this.calculateCostFromPricing(tokens, pricing)
  }
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '$0.00'
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: value < 0.01 ? 4 : 2,
  }).format(value)
}
