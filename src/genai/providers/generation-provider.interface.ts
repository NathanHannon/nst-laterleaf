export type GenerationModel = 'free' | 'pro' | 'podcast';
export type GenerationProviderName = 'gemini' | 'openai-compatible';

export interface TextGenerationRequest {
    prompt: string;
    model: GenerationModel;
}

export interface TextGenerationResult {
    text: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
}

export interface EmbeddingRequest {
    content: string;
    purpose: 'article_storage' | 'search_query';
    dimensions?: number;
}

export interface ChatGenerationRequest {
    message: string;
    fullContextPrompt: string;
    previousInteractionId?: string;
    model: GenerationModel;
}

export interface ChatGenerationResult {
    response: string;
    interactionId?: string;
}

export interface GenerationProvider {
    generateText(request: TextGenerationRequest): Promise<TextGenerationResult>;
    generateChatReply(request: ChatGenerationRequest): Promise<ChatGenerationResult>;
}