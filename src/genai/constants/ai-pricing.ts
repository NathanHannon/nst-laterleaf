interface TokenPricing {
    inputPerMillion: number;
    cachedInputPerMillion?: number;
    outputPerMillion: number;
}

export interface TextGenerationCost {
    inputCostUsd: number;
    outputCostUsd: number;
    totalCostUsd: number;
}

const TOKEN_PRICING: Record<string, TokenPricing> = {
    'gemini-3-flash-preview': { inputPerMillion: 0.5, cachedInputPerMillion: 0.05, outputPerMillion: 3 },
    'gemini-3.1-flash-lite': { inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 1.5 },
    'gpt-5.6-luna': { inputPerMillion: 0.2, cachedInputPerMillion: 0.1, outputPerMillion: 1.2 },
    'gpt-6-luna': { inputPerMillion: 0.1, cachedInputPerMillion: 0.05, outputPerMillion: 0.5 },
    'gpt-5.4-mini': { inputPerMillion: 0.75, cachedInputPerMillion: 0.375, outputPerMillion: 4.5 },
};

export function calculateTextGenerationCost(
    model: string,
    inputTokens?: number,
    outputTokens?: number,
    cachedInputTokens?: number,
): TextGenerationCost | undefined {
    const pricing = TOKEN_PRICING[model];
    if (!pricing || inputTokens === undefined || outputTokens === undefined) {
        return undefined;
    }

    const effectiveCachedTokens = Math.min(Math.max(cachedInputTokens ?? 0, 0), inputTokens);
    const uncachedInputTokens = inputTokens - effectiveCachedTokens;
    const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;

    const inputCostUsd =
        (uncachedInputTokens * pricing.inputPerMillion + effectiveCachedTokens * cachedRate) / 1_000_000;
    const outputCostUsd = (outputTokens * pricing.outputPerMillion) / 1_000_000;
    return {
        inputCostUsd,
        outputCostUsd,
        totalCostUsd: inputCostUsd + outputCostUsd,
    };
}

export function estimateTextGenerationCost(
    model: string,
    inputTokens?: number,
    outputTokens?: number,
    cachedInputTokens?: number,
): number | undefined {
    return calculateTextGenerationCost(model, inputTokens, outputTokens, cachedInputTokens)?.totalCostUsd;
}
