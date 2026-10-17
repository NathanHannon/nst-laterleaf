import { GenAiService } from './gen-ai.service';
import type { GenerationService } from './generation.service';
import type { AudioProcessingService } from './audio-processing.service';

describe('GenAiService', () => {
    it('uses the shared summary prompt and model for all subscription tiers', async () => {
        const generationService = {
            generateTextWithProvider: jest.fn().mockResolvedValue({
                text: 'OpenAI summary',
                model: 'gpt-6-luna',
                inputTokens: 1_000,
                outputTokens: 1_000,
            }),
        } as unknown as GenerationService;
        const service = new GenAiService({} as AudioProcessingService, generationService);
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

        await expect(service.generateSummary('Article content', false, undefined, 'en', 'openai-compatible'))
            .resolves.toBe('OpenAI summary');
        await expect(service.generateSummary('Article content', true, undefined, 'en', 'openai-compatible'))
            .resolves.toBe('OpenAI summary');

        expect(generationService.generateTextWithProvider).toHaveBeenCalledWith(
            'openai-compatible',
            expect.objectContaining({ model: 'free' }),
        );
        const firstRequest = generationService.generateTextWithProvider.mock.calls[0][1];
        const secondRequest = generationService.generateTextWithProvider.mock.calls[1][1];
        expect(secondRequest).toEqual(firstRequest);
        expect(firstRequest.prompt).toContain('## Key claims');
        expect(firstRequest.prompt).toContain('## Keep in mind');
        expect(firstRequest.prompt).toContain('## Reading map');
        expect(logSpy).toHaveBeenCalledWith('Model: gpt-6-luna');

        logSpy.mockRestore();
    });
});