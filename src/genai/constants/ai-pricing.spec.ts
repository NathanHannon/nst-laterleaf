import { calculateTextGenerationCost, estimateTextGenerationCost } from './ai-pricing';

describe('estimateTextGenerationCost', () => {
    it('estimates Gemini Flash cost from actual token counts', () => {
        expect(estimateTextGenerationCost('gemini-3-flash-preview', 1_000_000, 1_000_000)).toBe(3.5);
    });

    it('estimates GPT-6 Luna cost from actual token counts', () => {
        expect(estimateTextGenerationCost('gpt-6-luna', 1_000_000, 1_000_000)).toBe(0.6);
    });

    it('returns an OpenAI input/output cost breakdown', () => {
        expect(calculateTextGenerationCost('gpt-5.4-mini', 1_000, 1_000)).toEqual({
            inputCostUsd: 0.00075,
            outputCostUsd: 0.0045,
            totalCostUsd: 0.0052499999999999995,
        });
    });

    it('discounts cached input tokens when provided', () => {
        // 1M total input (800k cached @ $0.05/M + 200k uncached @ $0.50/M = $0.14) + 1M output ($3.00)
        expect(calculateTextGenerationCost('gemini-3-flash-preview', 1_000_000, 1_000_000, 800_000)).toEqual({
            inputCostUsd: 0.14,
            outputCostUsd: 3,
            totalCostUsd: 3.14,
        });
        // Clamps cached tokens to total input tokens
        expect(estimateTextGenerationCost('gpt-5.4-mini', 1_000_000, 0, 2_000_000)).toBe(0.375);
    });

    it('does not invent pricing for custom or incomplete results', () => {
        expect(estimateTextGenerationCost('custom-model', 100, 100)).toBeUndefined();
        expect(estimateTextGenerationCost('gpt-5.4-mini', undefined, 100)).toBeUndefined();
    });
});
