import { GenerationService } from './generation.service';
import type { GeminiGenerationAdapter } from './providers/gemini-generation.adapter';
import type { OpenAiCompatibleGenerationAdapter } from './providers/openai-compatible-generation.adapter';

describe('GenerationService', () => {
    const originalProvider = process.env.GENERATION_PROVIDER;
    const request = { model: 'free' as const, prompt: 'Summarize this' };

    const gemini = {
        generateText: jest.fn(),
        generateEmbeddings: jest.fn(),
        generateChatReply: jest.fn(),
    } as unknown as GeminiGenerationAdapter;
    const openAiCompatible = {
        generateText: jest.fn(),
        generateEmbeddings: jest.fn(),
        generateChatReply: jest.fn(),
    } as unknown as OpenAiCompatibleGenerationAdapter;

    const service = new GenerationService(gemini, openAiCompatible);

    afterEach(() => {
        jest.clearAllMocks();
        if (originalProvider === undefined) {
            delete process.env.GENERATION_PROVIDER;
        } else {
            process.env.GENERATION_PROVIDER = originalProvider;
        }
    });

    it('uses the OpenAI-compatible adapter by default', async () => {
        delete process.env.GENERATION_PROVIDER;
        jest.mocked(openAiCompatible.generateText).mockResolvedValue({ text: 'OpenAI response', model: 'openai-test' });

        await expect(service.generateText(request)).resolves.toEqual({
            text: 'OpenAI response',
            model: 'openai-test',
            estimatedCostUsd: undefined,
        });
        expect(openAiCompatible.generateText).toHaveBeenCalledWith(request);
        expect(gemini.generateText).not.toHaveBeenCalled();
    });

    it.each(['openai', 'openai-compatible'])('uses the OpenAI-compatible adapter for %s', async (provider) => {
        process.env.GENERATION_PROVIDER = provider;
        jest.mocked(openAiCompatible.generateText).mockResolvedValue({ text: 'Compatible response', model: 'openai-test' });

        await expect(service.generateText(request)).resolves.toEqual({
            text: 'Compatible response',
            model: 'openai-test',
            estimatedCostUsd: undefined,
        });
        expect(openAiCompatible.generateText).toHaveBeenCalledWith(request);
        expect(gemini.generateText).not.toHaveBeenCalled();
    });

    it('rejects unknown providers', () => {
        process.env.GENERATION_PROVIDER = 'unknown';
        expect(() => service.generateText(request)).toThrow('Unsupported generation provider: unknown');
    });

    it('runs an explicit provider without changing the configured default', async () => {
        process.env.GENERATION_PROVIDER = 'gemini';
        jest.mocked(openAiCompatible.generateText).mockResolvedValue({ text: 'Comparison', model: 'openai-test' });

        await expect(service.generateTextWithProvider('openai-compatible', request)).resolves.toEqual({
            text: 'Comparison',
            model: 'openai-test',
            estimatedCostUsd: undefined,
        });
        expect(openAiCompatible.generateText).toHaveBeenCalledWith(request);
        expect(gemini.generateText).not.toHaveBeenCalled();
        expect(process.env.GENERATION_PROVIDER).toBe('gemini');
    });

    it('always uses Gemini embeddings when text defaults to OpenAI-compatible', async () => {
        process.env.GENERATION_PROVIDER = 'openai-compatible';
        const embeddingRequest = {
            content: 'Article content',
            purpose: 'article_storage' as const,
            dimensions: 768,
        };
        jest.mocked(gemini.generateEmbeddings).mockResolvedValue([0.1, 0.2]);

        await expect(service.generateEmbeddings(embeddingRequest)).resolves.toEqual([0.1, 0.2]);
        expect(gemini.generateEmbeddings).toHaveBeenCalledWith(embeddingRequest);
        expect(openAiCompatible.generateEmbeddings).not.toHaveBeenCalled();
    });
});