import { GenAiService } from './gen-ai.service';
import type { GenerationService } from './generation.service';
import type { AudioProcessingService } from './audio-processing.service';

describe('GenAiService', () => {
    it('logs the actual OpenAI model and pricing for an overridden summary', async () => {
        const generationService = {
            generateTextWithProvider: jest.fn().mockResolvedValue({
                text: 'OpenAI summary',
                model: 'gpt-5.4-mini',
                inputTokens: 1_000,
                outputTokens: 1_000,
            }),
        } as unknown as GenerationService;
        const service = new GenAiService({} as AudioProcessingService, generationService);
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

        await expect(service.generateSummary('Article content', true, undefined, 'en', 'openai-compatible'))
            .resolves.toBe('OpenAI summary');

        expect(generationService.generateTextWithProvider).toHaveBeenCalledWith(
            'openai-compatible',
            expect.objectContaining({ model: 'pro' }),
        );
        expect(logSpy).toHaveBeenCalledWith('Model: gpt-5.4-mini');
        expect(logSpy).toHaveBeenCalledWith('💰 Total cost: $0.005250');

        logSpy.mockRestore();
    });
});