import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { GEMINI_MODELS } from './constants/ai-models';
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
import { normalizeAiProviderError } from './ai-provider-error';

interface CachedEmbeddingEntry {
    vector: number[];
    expiresAt: number;
}

const EMBEDDING_CACHE_MAX_ENTRIES = 5_000;
const EMBEDDING_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

@Injectable()
export class GenerationService {
    private readonly queryEmbeddingCache = new Map<string, CachedEmbeddingEntry>();

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

    private buildEmbeddingCacheKey(request: EmbeddingRequest): string {
        const normalized = request.content.trim().replace(/\s+/g, ' ').toLowerCase();
        return createHash('sha256')
            .update(JSON.stringify([GEMINI_MODELS.EMBEDDING, request.purpose, request.dimensions ?? null, normalized]))
            .digest('hex');
    }

    private getCachedQueryEmbedding(key: string): number[] | undefined {
        const entry = this.queryEmbeddingCache.get(key);
        if (!entry) return undefined;
        if (Date.now() > entry.expiresAt) {
            this.queryEmbeddingCache.delete(key);
            return undefined;
        }
        // Refresh LRU recency
        this.queryEmbeddingCache.delete(key);
        this.queryEmbeddingCache.set(key, entry);
        return [...entry.vector];
    }

    private setCachedQueryEmbedding(key: string, vector: number[]): void {
        if (vector.length === 0) return;
        if (this.queryEmbeddingCache.has(key)) {
            this.queryEmbeddingCache.delete(key);
        } else if (this.queryEmbeddingCache.size >= EMBEDDING_CACHE_MAX_ENTRIES) {
            const oldestKey = this.queryEmbeddingCache.keys().next().value;
            if (oldestKey !== undefined) {
                this.queryEmbeddingCache.delete(oldestKey);
            }
        }
        this.queryEmbeddingCache.set(key, {
            vector: [...vector],
            expiresAt: Date.now() + EMBEDDING_CACHE_TTL_MS,
        });
    }

    clearEmbeddingCache(): void {
        this.queryEmbeddingCache.clear();
    }

    private async generateWith(
        provider: GenerationProvider,
        request: TextGenerationRequest,
    ): Promise<TextGenerationResult> {
        let result: TextGenerationResult;
        try {
            result = await provider.generateText(request);
        } catch (error) {
            throw normalizeAiProviderError(error);
        }
        return {
            ...result,
            estimatedCostUsd: estimateTextGenerationCost(
                result.model,
                result.inputTokens,
                result.outputTokens,
                result.cachedInputTokens,
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

    async generateEmbeddings(request: EmbeddingRequest): Promise<number[]> {
        if (request.purpose === 'search_query') {
            const cacheKey = this.buildEmbeddingCacheKey(request);
            const cached = this.getCachedQueryEmbedding(cacheKey);
            if (cached) {
                return cached;
            }
            try {
                const vector = await this.gemini.generateEmbeddings(request);
                this.setCachedQueryEmbedding(cacheKey, vector);
                return vector;
            } catch (error: unknown) {
                throw normalizeAiProviderError(error);
            }
        }

        return this.gemini.generateEmbeddings(request).catch((error: unknown) => {
            throw normalizeAiProviderError(error);
        });
    }

    async generateChatReply(request: ChatGenerationRequest): Promise<ChatGenerationResult> {
        try {
            return await this.provider.generateChatReply(request);
        } catch (error) {
            throw normalizeAiProviderError(error);
        }
    }
}