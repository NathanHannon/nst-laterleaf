import { calculateTextGenerationCost, estimateTextGenerationCost } from './ai-pricing';

describe('estimateTextGenerationCost', () => {
    it('estimates Gemini Flash cost from actual token counts', () => {
        expect(estimateTextGenerationCost('gemini-3-flash-preview', 1_000_000, 1_000_000)).toBe(3.5);
    });

    it('estimates GPT-5.6 Luna cost from actual token counts', () => {
        expect(estimateTextGenerationCost('gpt-5.6-luna', 1_000_000, 1_000_000)).toBe(1.4);
    });

    it('returns an OpenAI input/output cost breakdown', () => {
        expect(calculateTextGenerationCost('gpt-5.4-mini', 1_000, 1_000)).toEqual({
            inputCostUsd: 0.00075,
            outputCostUsd: 0.0045,
            totalCostUsd: 0.0052499999999999995,
        });
    });

    it('does not invent pricing for custom or incomplete results', () => {
        expect(estimateTextGenerationCost('custom-model', 100, 100)).toBeUndefined();
        expect(estimateTextGenerationCost('gpt-5.4-mini', undefined, 100)).toBeUndefined();
    });
});