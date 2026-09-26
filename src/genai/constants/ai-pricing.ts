interface TokenPricing {
    inputPerMillion: number;
    outputPerMillion: number;
}

export interface TextGenerationCost {
    inputCostUsd: number;
    outputCostUsd: number;
    totalCostUsd: number;
}

const TOKEN_PRICING: Record<string, TokenPricing> = {
    'gemini-3-flash-preview': { inputPerMillion: 0.5, outputPerMillion: 3 },
    'gemini-3.1-flash-lite': { inputPerMillion: 0.25, outputPerMillion: 1.5 },
    'gpt-5.6-luna': { inputPerMillion: 0.2, outputPerMillion: 1.2 },
    'gpt-6-luna': { inputPerMillion: 0.1, outputPerMillion: 0.5 },
    'gpt-5.4-mini': { inputPerMillion: 0.75, outputPerMillion: 4.5 },
};

export function calculateTextGenerationCost(
    model: string,
    inputTokens?: number,
    outputTokens?: number,
): TextGenerationCost | undefined {
    const pricing = TOKEN_PRICING[model];
    if (!pricing || inputTokens === undefined || outputTokens === undefined) {
        return undefined;
    }

    const inputCostUsd = (inputTokens * pricing.inputPerMillion) / 1_000_000;
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
): number | undefined {
    return calculateTextGenerationCost(model, inputTokens, outputTokens)?.totalCostUsd;
}
