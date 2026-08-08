import { GoogleGenAI } from '@google/genai';
import { Injectable } from '@nestjs/common';
import { GEMINI_MODELS } from '../constants/ai-models';
import type {
    ChatGenerationRequest,
    ChatGenerationResult,
    EmbeddingRequest,
    GenerationModel,
    GenerationProvider,
    TextGenerationRequest,
    TextGenerationResult,
} from './generation-provider.interface';

@Injectable()
export class GeminiGenerationAdapter implements GenerationProvider {
    private getClient(): GoogleGenAI {
        const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error('Google API key not configured');
        }
        return new GoogleGenAI({ apiKey });
    }

    private getModel(model: GenerationModel): string {
        if (model === 'pro') return GEMINI_MODELS.PRO_TEXT;
        if (model === 'podcast') return GEMINI_MODELS.PODCAST;
        return GEMINI_MODELS.FREE_TEXT;
    }

    async generateText(request: TextGenerationRequest): Promise<TextGenerationResult> {
        const model = this.getModel(request.model);
        const interaction = await this.getClient().interactions.create({
            model,
            input: request.prompt,
            store: false,
        });

        return {
            text: interaction.output_text || '',
            model,
            inputTokens: interaction.usage?.total_input_tokens,
            outputTokens: interaction.usage?.total_output_tokens,
        };
    }

    async generateEmbeddings(request: EmbeddingRequest): Promise<number[]> {
        const response = await this.getClient().models.embedContent({
            model: GEMINI_MODELS.EMBEDDING,
            contents: [request.content],
            config: {
                outputDimensionality: request.dimensions,
                taskType: request.purpose === 'article_storage' ? 'RETRIEVAL_DOCUMENT' : 'RETRIEVAL_QUERY',
            },
        });

        const embedding = response.embeddings?.[0]?.values;
        return Array.isArray(embedding) ? embedding : [];
    }

    async generateChatReply(request: ChatGenerationRequest): Promise<ChatGenerationResult> {
        const createParams: Record<string, unknown> = {
            model: this.getModel(request.model),
            input: request.previousInteractionId ? request.message : request.fullContextPrompt,
        };

        if (request.previousInteractionId) {
            createParams.previous_interaction_id = request.previousInteractionId;
        }

        const interaction = await this.getClient().interactions.create(createParams as any);
        return {
            response: interaction.output_text || '',
            interactionId: interaction.id,
        };
    }
}