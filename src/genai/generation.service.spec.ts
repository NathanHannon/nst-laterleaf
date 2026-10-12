import { HttpException } from '@nestjs/common';
import { GenerationService } from './generation.service';
import {
    AI_PROVIDER_CREDITS_EXHAUSTED,
    AI_PROVIDER_CREDITS_EXHAUSTED_MESSAGE,
} from './ai-provider-error';
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

    it('uses Gemini by default', async () => {
        delete process.env.GENERATION_PROVIDER;
        jest.mocked(gemini.generateText).mockResolvedValue({ text: 'Gemini response', model: 'gemini-test' });

        await expect(service.generateText(request)).resolves.toEqual({
            text: 'Gemini response',
            model: 'gemini-test',
            estimatedCostUsd: undefined,
        });
        expect(gemini.generateText).toHaveBeenCalledWith(request);
        expect(openAiCompatible.generateText).not.toHaveBeenCalled();
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

    it('returns a stable 402 error when a provider reports exhausted credits', async () => {
        process.env.GENERATION_PROVIDER = 'openai-compatible';
        jest.mocked(openAiCompatible.generateText).mockRejectedValue({
            status: 429,
            code: 'insufficient_quota',
            message: 'You exceeded your current quota. Check your plan and billing details.',
        });

        try {
            await service.generateText(request);
            fail('Expected generation to reject');
        } catch (error) {
            expect(error).toBeInstanceOf(HttpException);
            expect((error as HttpException).getStatus()).toBe(402);
            expect((error as HttpException).getResponse()).toEqual({
                statusCode: 402,
                error: {
                    code: AI_PROVIDER_CREDITS_EXHAUSTED,
                    message: AI_PROVIDER_CREDITS_EXHAUSTED_MESSAGE,
                },
            });
        }
    });

    it('preserves ordinary provider rate-limit errors', async () => {
        process.env.GENERATION_PROVIDER = 'openai-compatible';
        const rateLimitError = { status: 429, code: 'rate_limit_exceeded', message: 'Too many requests' };
        jest.mocked(openAiCompatible.generateText).mockRejectedValue(rateLimitError);

        await expect(service.generateText(request)).rejects.toBe(rateLimitError);
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

    it('always uses Gemini embeddings when text uses OpenAI-compatible', async () => {
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