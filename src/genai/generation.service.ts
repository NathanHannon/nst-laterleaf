import { Injectable } from '@nestjs/common';
import { GeminiGenerationAdapter } from './providers/gemini-generation.adapter';
import type {
    ChatGenerationRequest,
    ChatGenerationResult,
    EmbeddingRequest,
    GenerationProvider,
    GenerationProviderName,
    TextGenerationRequest,
    TextGenerationResult,
} from './providers/generation-provider.interface';
import { OpenAiCompatibleGenerationAdapter } from './providers/openai-compatible-generation.adapter';
import { estimateTextGenerationCost } from './constants/ai-pricing';

@Injectable()
export class GenerationService {
    constructor(
        private readonly gemini: GeminiGenerationAdapter,
        private readonly openAiCompatible: OpenAiCompatibleGenerationAdapter,
    ) { }

    private get provider(): GenerationProvider {
        const provider = (process.env.GENERATION_PROVIDER || 'gemini').toLowerCase();
        if (provider === 'gemini') return this.gemini;
        if (provider === 'openai' || provider === 'openai-compatible') return this.openAiCompatible;
        throw new Error(`Unsupported generation provider: ${provider}`);
    }

    private getProvider(provider: GenerationProviderName): GenerationProvider {
        return provider === 'gemini' ? this.gemini : this.openAiCompatible;
    }

    private async generateWith(
        provider: GenerationProvider,
        request: TextGenerationRequest,
    ): Promise<TextGenerationResult> {
        const result = await provider.generateText(request);
        return {
            ...result,
            estimatedCostUsd: estimateTextGenerationCost(
                result.model,
                result.inputTokens,
                result.outputTokens,
            ),
        };
    }

    generateText(request: TextGenerationRequest): Promise<TextGenerationResult> {
        return this.generateWith(this.provider, request);
    }

    generateTextWithProvider(
        provider: GenerationProviderName,
        request: TextGenerationRequest,
    ): Promise<TextGenerationResult> {
        return this.generateWith(this.getProvider(provider), request);
    }

    generateEmbeddings(request: EmbeddingRequest): Promise<number[]> {
        return this.gemini.generateEmbeddings(request);
    }

    generateChatReply(request: ChatGenerationRequest): Promise<ChatGenerationResult> {
        return this.provider.generateChatReply(request);
    }
}