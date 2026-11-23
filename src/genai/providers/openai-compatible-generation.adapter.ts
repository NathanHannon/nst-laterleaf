import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { OPENAI_MODELS } from '../constants/ai-models';
import type {
    ChatGenerationRequest,
    ChatGenerationResult,
    GenerationModel,
    GenerationProvider,
    TextGenerationRequest,
    TextGenerationResult,
} from './generation-provider.interface';

@Injectable()
export class OpenAiCompatibleGenerationAdapter implements GenerationProvider {
    private getClient(): OpenAI {
        const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY || process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error('OpenAI-compatible API key not configured');
        }

        return new OpenAI({
            apiKey,
            baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL,
        });
    }

    private getModel(model: GenerationModel): string {
        if (model === 'pro') {
            return process.env.OPENAI_COMPATIBLE_PRO_MODEL || process.env.OPENAI_COMPATIBLE_TEXT_MODEL || OPENAI_MODELS.PRO_TEXT;
        }
        if (model === 'podcast') {
            return process.env.OPENAI_COMPATIBLE_PODCAST_MODEL || process.env.OPENAI_COMPATIBLE_TEXT_MODEL || OPENAI_MODELS.PODCAST;
        }
        return process.env.OPENAI_COMPATIBLE_TEXT_MODEL || OPENAI_MODELS.FREE_TEXT;
    }

    async generateText(request: TextGenerationRequest): Promise<TextGenerationResult> {
        const model = this.getModel(request.model);
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
        if (request.systemInstruction) {
            messages.push({ role: 'system', content: request.systemInstruction });
        }
        messages.push({ role: 'user', content: request.prompt });

        const completion = await this.getClient().chat.completions.create({
            model,
            messages,
        });

        return {
            text: completion.choices[0]?.message.content || '',
            model,
            inputTokens: completion.usage?.prompt_tokens,
            cachedInputTokens: completion.usage?.prompt_tokens_details?.cached_tokens,
            outputTokens: completion.usage?.completion_tokens,
        };
    }

    async generateChatReply(request: ChatGenerationRequest): Promise<ChatGenerationResult> {
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = request.systemInstruction
            ? [
                { role: 'system', content: request.systemInstruction },
                ...(request.history ?? []).map((msg) => ({
                    role: msg.role,
                    content: msg.content,
                })),
                { role: 'user', content: request.userPrompt ?? request.message },
            ]
            : [{ role: 'user', content: request.fullContextPrompt }];

        const completion = await this.getClient().chat.completions.create({
            model: this.getModel(request.model),
            messages,
        });

        return {
            response: completion.choices[0]?.message.content || '',
            interactionId: completion.id,
        };
    }
}