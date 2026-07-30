import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { GoogleGenAI } from '@google/genai';
import { Injectable } from '@nestjs/common';
import path from 'path';
import { GEMINI_MODELS } from './constants/ai-models';
import { PERSONA_PAIRS } from './interfaces/persona-parts.interface';
import { AudioProcessingService } from './audio-processing.service';

const LANGUAGE_MAP: Record<string, string> = {
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    it: 'Italian',
    pt: 'Portuguese',
    'pt-BR': 'Portuguese (Brazil)',
    nl: 'Dutch',
    ru: 'Russian',
    pl: 'Polish',
    tr: 'Turkish',
    th: 'Thai',
    vi: 'Vietnamese',
    id: 'Indonesian',
    zh: 'Chinese',
    ja: 'Japanese',
    ko: 'Korean',
    hi: 'Hindi',
    ar: 'Arabic',
};

/**
 * Ports lb-laterleaf/src/services/gen-ai.service.ts. Uses the `@google/genai`
 * Interactions API (`ai.interactions.create()`) for text/podcast-script/chat
 * generation and Google Cloud TTS (Standard voices) for single-speaker speech.
 * Stateless besides its AudioProcessingService dependency, so default
 * (singleton) Nest scope is used — matching the LB TRANSIENT service's
 * effective behavior since it holds no per-request state.
 */
@Injectable()
export class GenAiService {
    constructor(private readonly audioProcessingService: AudioProcessingService) { }

    private getLanguageName(codeOrName: string): string {
        // If it's a known code, return the name
        if (LANGUAGE_MAP[codeOrName]) {
            return LANGUAGE_MAP[codeOrName];
        }
        // If it looks like a code (2-3 chars) but not in our map, default to English to be safe
        if (codeOrName.length <= 3) {
            return 'English';
        }
        // Otherwise assume it's already a full name (legacy support)
        return codeOrName;
    }

    /**
     * Returns an instance of the GoogleGenAI client using the configured API key.
     *
     * The API key is retrieved from the environment variables `GOOGLE_API_KEY` or `GEMINI_API_KEY`.
     * If neither is set, an error is thrown.
     *
     * @throws {Error} If no Google API key is configured in the environment variables.
     * @returns {GoogleGenAI} An initialized GoogleGenAI client.
     */
    private getAiClient(): GoogleGenAI {
        const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error('Google API key not configured');
        }
        return new GoogleGenAI({ apiKey: apiKey });
    }

    /**
     * Returns an instance of the Google Cloud Text-to-Speech client using the service account key.
     */
    private getGoogleCloudTtsClient(): TextToSpeechClient {
        const keyFile = process.env.GOOGLE_CLOUD_TTS_KEY_FILE || './keys/google-cloud-tts-key.json';
        const absoluteKeyPath = path.resolve(process.cwd(), keyFile);

        return new TextToSpeechClient({
            keyFilename: absoluteKeyPath,
        });
    }

    /**
     * Maps internal voice names to Google Cloud TTS Standard voices.
     * Standard voices are the cheapest option ($4.00/1M chars).
     */
    private getGoogleCloudVoice(voiceName: string): { name: string; ssmlGender: 'MALE' | 'FEMALE' } {
        const voiceMap: Record<string, { name: string; ssmlGender: 'MALE' | 'FEMALE' }> = {
            Puck: { name: 'en-US-Standard-B', ssmlGender: 'MALE' },     // Energetic Male (Standard)
            Charon: { name: 'en-US-Standard-D', ssmlGender: 'MALE' },   // Deep Male (Standard)
            Kore: { name: 'en-US-Standard-F', ssmlGender: 'FEMALE' },   // Warm Female (Standard)
            Fenrir: { name: 'en-US-Standard-I', ssmlGender: 'MALE' },   // Authoritative Male (Standard)
        };

        return voiceMap[voiceName] || { name: 'en-US-Standard-B', ssmlGender: 'MALE' };
    }

    /**
     * Executes an AI operation with exponential backoff retry logic for rate limits.
     */
    private async withRetry<T>(
        operation: () => Promise<T>,
        maxRetries: number = 3,
        initialDelay: number = 2000,
    ): Promise<T> {
        let lastError: any;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error: any) {
                lastError = error;

                // Check if error is retryable (429 Too Many Requests or 503 Service Unavailable)
                const errorCode = error?.status || error?.code || error?.error?.code;
                const errorMessage = error?.message || JSON.stringify(error);

                const isRateLimit =
                    errorCode === 429 ||
                    errorCode === 'RESOURCE_EXHAUSTED' ||
                    errorMessage.includes('RESOURCE_EXHAUSTED') ||
                    errorMessage.includes('429');

                const isServerOverload = errorCode === 503;

                if ((isRateLimit || isServerOverload) && attempt < maxRetries) {
                    const delay = initialDelay * Math.pow(2, attempt);
                    console.warn(`⚠️ AI Service: Rate limit/Quota hit. Retrying in ${delay}ms... (Attempt ${attempt + 1}/${maxRetries})`);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    continue;
                }

                throw error;
            }
        }

        throw lastError;
    }

    /**
     * Estimates the number of tokens in a given text string.
     *
     * This method splits the input text into words and assumes that, on average,
     * one token corresponds to approximately four words. The result is rounded up
     * to the nearest integer.
     *
     * @param text - The input string to estimate tokens for.
     * @returns The estimated number of tokens.
     */
    private estimateTokens(text: string): number {
        const words = text.trim().split(/\s+/).length;
        // Standard estimation: 1 word ≈ 1.3 tokens (approx 0.75 words/token)
        return Math.ceil(words * 1.3);
    }

    /**
     * Calculates the cost of using the Gemini AI model based on input and output token counts,
     * and whether the user is a Pro user or not. Pricing rates are applied according to official
     * Gemini 3 Flash (Pro) and Gemini 3.1 Flash-Lite (Free) rates.
     *
     * @param inputTokens - The number of input tokens used in the request.
     * @param outputTokens - The number of output tokens generated by the model.
     * @param isProUser - Indicates if the user is a Pro user (true for Pro, false for Flash-Lite).
     * @returns An object containing the input cost, output cost, total cost, and the model name.
     */
    private calculateCost(
        inputTokens: number,
        outputTokens: number,
        isProUser: boolean,
    ): {
        inputCost: number;
        outputCost: number;
        totalCost: number;
        model: string;
    } {
        const model = this.getModel(isProUser);
        let inputCost = 0;
        let outputCost = 0;

        if (isProUser) {
            // Gemini 3 Flash pricing - Official rates
            // Input: $0.50 per 1M tokens, Output: $3.00 per 1M tokens (Max output: 64K tokens)
            const inputRate = 0.5 / 1000000;
            const outputRate = 3.0 / 1000000;

            inputCost = inputTokens * inputRate;
            outputCost = outputTokens * outputRate;
        } else {
            // Gemini 3.1 Flash-Lite pricing (per 1M tokens) - Official rates
            // Input: $0.25, Output: $1.50 (Max output: 64K tokens)
            const inputRate = 0.25 / 1000000;
            const outputRate = 1.5 / 1000000;

            inputCost = inputTokens * inputRate;
            outputCost = outputTokens * outputRate;
        }

        return {
            inputCost,
            outputCost,
            totalCost: inputCost + outputCost,
            model,
        };
    }

    /**
     * Returns the appropriate Gemini model name based on the user's subscription status.
     *
     * @param isProUser - Indicates whether the user is a Pro (paid) user. Defaults to `false`.
     * @returns The model name string: "gemini-3-flash-preview" for Pro users, "gemini-3.1-flash-lite" for free users.
     */
    private getModel(isProUser: boolean = false): string {
        // Use Flash-Lite for free users (much cheaper), Gemini 3 Flash for paid users
        return isProUser ? GEMINI_MODELS.PRO_TEXT : GEMINI_MODELS.FREE_TEXT;
    }

    /**
     * Generates AI-powered content based on the provided input string.
     * Calculates input and output token counts, estimates costs, and logs relevant information.
     *
     * @param content - The input string to be processed by the AI model.
     * @param isProUser - Optional flag indicating if the user is a Pro user, which may affect model selection and cost calculation. Defaults to `false`.
     * @returns A promise that resolves to the generated content as a string.
     */
    async generateContent(content: string, isProUser: boolean = false) {
        const ai = this.getAiClient();

        const interaction = await this.withRetry(() =>
            ai.interactions.create({
                model: this.getModel(isProUser),
                input: content,
                store: false,
            }),
        );

        const inputTokens = interaction.usage?.total_input_tokens ?? this.estimateTokens(content);
        const outputTokens = interaction.usage?.total_output_tokens ?? this.estimateTokens(interaction.output_text || '');
        const costs = this.calculateCost(inputTokens, outputTokens, isProUser);

        console.log(`=== AI CONTENT GENERATION COST ===`);
        console.log(`Model: ${costs.model}`);
        console.log(`💰 Total cost: $${costs.totalCost.toFixed(6)}`);
        console.log(`📊 Tokens: ${(inputTokens + outputTokens).toLocaleString()}`);
        console.log(`===================================`);

        return interaction.output_text;
    }

    /**
     * Analyzes the provided article content and returns helpful reading metrics.
     *
     * The analysis includes:
     * - Estimated reading time
     * - Reading difficulty level (beginner/intermediate/advanced)
     * - Primary topics/categories
     * - Article type (e.g., news, opinion, tutorial, research)
     * - Key concepts mentioned
     *
     * The result is formatted as JSON with no editorial commentary about quality or truthfulness.
     *
     * @param content - The article content to analyze.
     * @param isProUser - Optional flag indicating if the user is a Pro user, which may affect the AI model used.
     * @returns A promise that resolves to the parsed reading metrics as an object, or `null` if parsing fails.
     */
    async analyzeReadingMetrics(content: string, isProUser: boolean = false) {
        const ai = this.getAiClient();

        const prompt = `Analyze this article and provide helpful reading metrics (no quality judgments):

    Content: ${content}

    Please provide:
    1. Estimated reading time
    2. Reading difficulty level (beginner/intermediate/advanced)
    3. Primary topics/categories
    4. Article type (news, opinion, tutorial, research, etc.)
    5. Key concepts mentioned

    Format as JSON with no editorial commentary about quality or truthfulness.`;

        const interaction = await this.withRetry(() =>
            ai.interactions.create({
                model: this.getModel(isProUser),
                input: prompt,
                store: false,
            }),
        );

        try {
            return interaction.output_text ? JSON.parse(interaction.output_text) : null;
        } catch (error) {
            console.error('Failed to parse reading metrics JSON, returning null:', error);
            return null;
        }
    }

    /**
     * Suggests 3-5 tags for an article based on its content.
     * Returns an array of strings representing the suggested tags.
     */
    async suggestTags(title: string, content: string, isProUser: boolean = false): Promise<string[]> {
        const ai = this.getAiClient();

        // Use a smaller portion of content for tagging to save tokens
        const truncatedContent = content.substring(0, 2000);

        const prompt = `Suggest 3-5 concise, high-level tags for an article with the following title and content.
    Title: ${title}
    Content: ${truncatedContent}

    Guidelines:
    - Use broad, helpful categories (e.g., "Technology", "Health", "Politics", "Cooking").
    - Avoid hyperspecific SEO keywords or names of people/companies unless they define the topic.
    - Respond ONLY with a JSON array of strings. Case: Title Case.
    Example: ["Technology", "Artificial Intelligence", "Future of Work"]`;

        try {
            // Use FREE_TEXT model for everyone
            const interaction = await this.withRetry(() =>
                ai.interactions.create({
                    model: GEMINI_MODELS.FREE_TEXT,
                    input: prompt,
                    store: false,
                }),
            );

            const text = interaction.output_text || '[]';
            // Basic extraction if it wrapped in markdown code blocks
            const jsonStr = text.includes('```json')
                ? text.split('```json')[1].split('```')[0]
                : text.includes('```')
                    ? text.split('```')[1].split('```')[0]
                    : text;

            const tags = JSON.parse(jsonStr.trim());
            return Array.isArray(tags) ? tags.slice(0, 5) : [];
        } catch (error: any) {
            console.error('⚠️ [TAGS] AI tag suggestion failed:', error.message);
            return [];
        }
    }

    async generateSummary(
        content: string,
        isProUser: boolean = false,
        options?: { maxRetries?: number },
        languageCodeOrName: string = 'en',
    ) {
        const ai = this.getAiClient();
        const language = this.getLanguageName(languageCodeOrName);

        // Truncate very long articles to control input costs
        const maxInputTokens = isProUser ? 16000 : 4000; // Much higher limit for pro users
        const maxInputWords = maxInputTokens * 4;

        let processedContent = content;
        if (content.length > maxInputWords) {
            processedContent = content.substring(0, maxInputWords) + '...';
            console.log(`✂️ Truncated article from ${content.length} to ${processedContent.length} characters`);
        }

        // Calculate optimal sizing based on 10:1 input:output ratio
        const contentTokens = this.estimateTokens(processedContent);
        const targetOutputTokens = Math.ceil(contentTokens / 10); // 10:1 ratio
        const targetOutputWords = targetOutputTokens * 4; // Convert back to words for prompt

        // Set reasonable bounds for output size - much more generous for pro
        const minWords = isProUser ? 200 : 50; // Higher minimum for pro
        const maxWords = isProUser ? 800 : 150; // Much higher max for pro
        const optimalWords = Math.max(minWords, Math.min(maxWords, targetOutputWords));

        console.log(`📏 Input sizing - Content tokens: ${contentTokens}, Target output: ${targetOutputTokens} tokens (${optimalWords} words)`);

        const prompt = isProUser
            ? `Provide a concise, structured analysis of this article in exactly ${optimalWords} words.

      IMPORTANT: The output MUST be in ${language}.
      Translate the section headers (e.g. "Main Theme", "Key Points") into ${language} as well.

      ${processedContent}

      Format:

      ## Main Theme
      [1-2 sentences: core topic and argument in ${language}]

      ## Key Points
      [3-4 bullet points: most important arguments in ${language}]

      ## Evidence
      [1-2 sentences: data, studies, or examples mentioned in ${language}]

      ## Significance
      [1-2 sentences: why this matters in ${language}]

      ## Notable Quote
      [1 key quote that captures the essence, with proper attribution. Keep the quote in its ORIGINAL language, but translate any commentary.]

      Keep the total response to approximately ${optimalWords} words.`
            : `Summarize this article in exactly ${optimalWords} words in ${language}, focusing on the main points:

      ${processedContent}

      Be factual and neutral. Use exactly ${optimalWords} words - no more, no less. Answer in ${language}.`;

        // Calculate token usage
        const inputTokens = this.estimateTokens(prompt);

        const interaction = await this.withRetry(
            () =>
                ai.interactions.create({
                    model: this.getModel(isProUser),
                    input: prompt,
                    store: false,
                }),
            options?.maxRetries,
        );

        const outputTokens = interaction.usage?.total_output_tokens ?? this.estimateTokens(interaction.output_text || '');
        const actualInputTokens = interaction.usage?.total_input_tokens ?? inputTokens;
        const totalTokens = actualInputTokens + outputTokens;

        // Calculate costs
        const costs = this.calculateCost(actualInputTokens, outputTokens, isProUser);

        console.log(`=== AI REQUEST COST ANALYSIS ===`);
        console.log(`Model: ${costs.model}`);
        console.log(`User tier: ${isProUser ? 'Pro' : 'Free'}`);
        console.log(`📊 Sizing ratio: ${contentTokens}:${outputTokens} (${(contentTokens / outputTokens).toFixed(1)}:1)`);
        console.log(`🎯 Target ratio: 10:1 | Optimal words: ${optimalWords}`);
        console.log(`Input tokens: ${actualInputTokens.toLocaleString()}`);
        console.log(`Output tokens: ${outputTokens.toLocaleString()}`);
        console.log(`Total tokens: ${totalTokens.toLocaleString()}`);
        console.log(`💰 Input cost: $${costs.inputCost.toFixed(6)}`);
        console.log(`💰 Output cost: $${costs.outputCost.toFixed(6)}`);
        console.log(`💰 Total cost: $${costs.totalCost.toFixed(6)}`);
        console.log(`📄 Content length: ${content.length.toLocaleString()} characters`);
        console.log(`================================`);

        return interaction.output_text;
    }

    /**
     * Translates article content into the specified target language.
     * Preserves Markdown formatting and tone.
     */
    async translateArticle(content: string, targetLanguage: string, isProUser: boolean = false): Promise<string> {
        const ai = this.getAiClient();

        // Use FREE_TEXT model for translation (efficient/cheap), upgrade to Pro only if requested
        const model = GEMINI_MODELS.FREE_TEXT;

        // Truncate safely: 50k chars is ~8-10k words (approx. 30-45 min read), covering 99.9% of web articles
        const maxChars = 50000;
        const processedContent =
            content.length > maxChars ? content.substring(0, maxChars) + '\n\n[Translation truncated due to length...]' : content;

        const prompt = `You are a professional translator. Translate the following text into ${targetLanguage}.

    CRITICAL INSTRUCTIONS:
    1. Preserve all Markdown formatting, links, and HTML structure exactly.
    2. Maintain the original tone.
    3. Output ONLY the translated text. No preamble.

    Original Text:
    ${processedContent}`;

        // Calculate input tokens
        const inputTokens = this.estimateTokens(prompt);

        const interaction = await this.withRetry(() =>
            ai.interactions.create({
                model: model,
                input: prompt,
                store: false,
            }),
        );

        const translation = interaction.output_text || '';

        const outputTokens = interaction.usage?.total_output_tokens ?? this.estimateTokens(translation);
        const actualInputTokens = interaction.usage?.total_input_tokens ?? inputTokens;
        const costs = this.calculateCost(actualInputTokens, outputTokens, false);

        console.log(`=== AI TRANSLATION COST ===`);
        console.log(`Model: ${costs.model}`);
        console.log(`Target: ${targetLanguage}`);
        console.log(`💰 Total cost: $${costs.totalCost.toFixed(6)}`);
        console.log(`📊 Tokens: ${(actualInputTokens + outputTokens).toLocaleString()}`);
        console.log(`===========================`);

        return translation;
    }

    /**
     * Extracts key quotes or important statements from a given article using an AI model.
     *
     * The number of quotes extracted depends on the user's subscription status:
     * - Pro users receive 4-6 quotes.
     * - Non-pro users receive 2-3 quotes.
     *
     * The method sends the article content to the AI model, requests direct quotes that capture the main ideas,
     * and calculates the token usage and associated costs for the operation.
     *
     * @param content - The article content from which to extract key quotes.
     * @param isProUser - Indicates whether the user has a pro subscription. Defaults to `false`.
     * @returns A promise that resolves to a string containing the extracted quotes.
     */
    async extractKeyQuotes(content: string, isProUser: boolean = false) {
        const ai = this.getAiClient();

        const quotesCount = isProUser ? '4-6' : '2-3';
        const prompt = `Extract ${quotesCount} key quotes or important statements from this article:

    ${content}

    Return only direct quotes that capture the main ideas.`;

        // Calculate input tokens
        const inputTokens = this.estimateTokens(prompt);

        const interaction = await this.withRetry(() =>
            ai.interactions.create({
                model: this.getModel(isProUser),
                input: prompt,
                store: false,
            }),
        );

        const outputTokens = interaction.usage?.total_output_tokens ?? this.estimateTokens(interaction.output_text || '');
        const actualInputTokens = interaction.usage?.total_input_tokens ?? inputTokens;
        const costs = this.calculateCost(actualInputTokens, outputTokens, isProUser);

        console.log(`=== AI QUOTES EXTRACTION COST ===`);
        console.log(`Model: ${costs.model}`);
        console.log(`💰 Total cost: $${costs.totalCost.toFixed(6)}`);
        console.log(`📊 Tokens: ${(actualInputTokens + outputTokens).toLocaleString()}`);
        console.log(`=================================`);

        return interaction.output_text;
    }

    /**
     * Generates a list of relevant tags for the given article content using an AI model.
     *
     * The AI analyzes the provided content and returns up to `maxTags` tags that categorize the article.
     * Tags are single words or short phrases (2-3 words max), lowercase, and represent general categories,
     * topics, or themes useful for organizing and finding similar articles.
     *
     * The function uses the "gemini-2.5-flash-lite" model for cost efficiency, estimates token usage,
     * and logs the cost details. If the AI response cannot be parsed as a JSON array, an empty array is returned.
     *
     * @param content - The article content to analyze and generate tags for.
     * @param maxTags - The maximum number of tags to generate (default is 5).
     * @returns A promise that resolves to an array of tag strings.
     */
    async generateTags(content: string, maxTags: number = 5) {
        const ai = this.getAiClient();

        const prompt = `Analyze this article and generate ${maxTags} relevant tags that categorize its content:

    ${content}

    Return only a JSON array of tag strings, no other text. Tags should be:
    - Single words or short phrases (2-3 words max)
    - Lowercase
    - General categories, topics, or themes
    - Useful for organizing and finding similar articles

    Example format: ["technology", "artificial intelligence", "business", "innovation", "startup"]`;

        // Always use Flash-Lite for cost efficiency
        const inputTokens = this.estimateTokens(prompt);

        const interaction = await this.withRetry(() =>
            ai.interactions.create({
                model: GEMINI_MODELS.FREE_TEXT,
                input: prompt,
                store: false,
            }),
        );

        const outputTokens = interaction.usage?.total_output_tokens ?? this.estimateTokens(interaction.output_text || '');
        const actualInputTokens = interaction.usage?.total_input_tokens ?? inputTokens;
        const costs = this.calculateCost(actualInputTokens, outputTokens, false);

        console.log(`=== AI TAG GENERATION COST ===`);
        console.log(`Model: ${costs.model}`);
        console.log(`💰 Total cost: $${costs.totalCost.toFixed(6)}`);
        console.log(`📊 Tokens: ${(actualInputTokens + outputTokens).toLocaleString()}`);
        console.log(`🏷️ Max tags: ${maxTags}`);
        console.log(`===============================`);

        try {
            const tags = JSON.parse(interaction.output_text || '[]');
            return Array.isArray(tags) ? tags.slice(0, maxTags) : [];
        } catch (error) {
            console.log('Failed to parse tags JSON, returning empty array:', error);
            return [];
        }
    }

    /**
     * Generates vector embeddings for the provided content using the Gemini embedding model.
     *
     * Estimates the token count and calculates the cost for generating embeddings.
     * Logs model information, token count, and cost to the console.
     * Returns the embedding vector as an array of numbers, or an empty array if an error occurs.
     *
     * @param content - The input string to generate embeddings for.
     * @returns A promise that resolves to an array of numbers representing the embedding vector.
     */
    async generateEmbeddings(
        content: string,
        options: { purpose: 'article_storage' | 'search_query'; contextId?: string } = {
            purpose: 'search_query',
        },
    ): Promise<number[]> {
        try {
            const ai = this.getAiClient();

            // Translate your internal 'purpose' into the Gemini API's 'taskType'
            const taskType = options.purpose === 'article_storage' ? 'RETRIEVAL_DOCUMENT' : 'RETRIEVAL_QUERY';

            // For consistency, add cost calculation for embeddings
            const inputTokens = this.estimateTokens(content);
            // Pricing for gemini-embedding-2: $0.20/1M tokens (text)
            const costPerMillionTokens = 0.2;
            const cost = (inputTokens / 1000000) * costPerMillionTokens;

            const logTitle = options.purpose === 'article_storage' ? 'AI ARTICLE EMBEDDING' : 'AI SEARCH QUERY EMBEDDING';
            const contextLog =
                options.purpose === 'article_storage' && options.contextId
                    ? `Article ID: ${options.contextId}`
                    : `Query Length: ${content.length} chars`;

            console.log(`=== ${logTitle} COST ===`);
            console.log(`Model: gemini-embedding-2`);
            console.log(`Context: ${contextLog}`);
            console.log(`💰 Total cost: $${cost.toFixed(6)}`);
            console.log(`📊 Tokens: ${inputTokens.toLocaleString()}`);
            console.log(`=================================`);

            const response = await this.withRetry(() =>
                ai.models.embedContent({
                    model: GEMINI_MODELS.EMBEDDING,
                    contents: [content],
                    config: {
                        outputDimensionality: 768,
                        taskType: taskType,
                    },
                }),
            );

            const embedding = response.embeddings?.[0]?.values;
            return Array.isArray(embedding) ? embedding : [];
        } catch (error) {
            console.error(`Failed to generate embeddings for purpose "${options.purpose}", returning empty array:`, error);
            return [];
        }
    }

    /**
     * Generates a NotebookLM-style conversational script between two speakers
     * CRITICAL: Script output must stay under 8192 tokens for TTS model compatibility
     */
    async generatePodcastScript(
        articleTitle: string,
        articleContent: string,
        options: {
            duration?: 'short' | 'medium' | 'long';
            style?: 'casual' | 'professional' | 'educational';
            personaId?: string;
            language?: string;
        } = {},
    ): Promise<string> {
        const ai = this.getAiClient();
        const { duration = 'medium', style = 'casual', personaId = 'zephyr-charon', language } = options;

        // Truncate content for context window
        const maxLength = 8000; // Increased for Gemini 3
        const content = articleContent.length > maxLength ? articleContent.substring(0, maxLength) + '...' : articleContent;

        // TTS token limits - restored for chunking strategy
        const ttsTokenLimits = {
            short: 2500, // ~4-5 minutes
            medium: 4500, // ~8-10 minutes
            long: 7500, // ~15 minutes
        };

        const durationMap = {
            short: '4-5 minutes of natural conversation',
            medium: '8-10 minutes of natural conversation',
            long: '15 minutes of natural conversation',
        };

        const maxTokens = ttsTokenLimits[duration];
        const estimatedWords = maxTokens * 0.75;

        const persona = PERSONA_PAIRS[personaId as keyof typeof PERSONA_PAIRS] || PERSONA_PAIRS['zephyr-charon'];

        const prompt = `You are a world-class podcast scriptwriter.
Roleplay a conversation between two speakers with the following traits:

Speaker 1: ${persona.s1.trait}
Speaker 2: ${persona.s2.trait}

STRICT RULES:
1. Output labels MUST be "Speaker 1:" and "Speaker 2:". Do NOT use their names.
2. Style: ${persona.scriptStyle}. ${persona.scriptStyle.includes('professional')
                ? 'Be clear, concise, and professional. Avoid filler words.'
                : 'Enforce realism with disfluencies like "um", "uh", "like", and natural stutters or self-corrections. One speaker should be the "explainer" and the other the "curious reactor".'
            }
3. BANNED PHRASES: Never use "delve", "dive in", "tapestry", "testament", "uncover", "in conclusion", or "to summarize".
5. Language: ${language ? `The entire conversation MUST be in ${language}. Translate any concepts naturally but keep the speakers' personalities.` : 'The conversation should be in English.'}
4. Do NOT include any stage directions, music cues, or metadata.

Generate a high-energy, collaborative "deep dive" conversation between Speaker 1 and Speaker 2 about this article.
The goal is to make the listener feel like they are eavesdropping on two friends who are genuinely excited to "geek out" over this specific content.

ARTICLE: "${articleTitle}"
${content}

REQUIREMENTS:
1. Create a ${durationMap[duration]} with a ${style} tone.
2. CRITICAL: Total script must be under ${estimatedWords} words (TTS has strict ${maxTokens} token limit).
3. STYLE: This is NOT a summary. It's a natural conversation with banter and joint discovery. They should build on each other's points ("Yes, and...", "Wait, that's wild because...").
4. STRUCTURE: Start with a hook about why this matters, explore the most interesting parts of the content, and end with a "big picture" takeaway.
5. Do NOT use the article title verbatim. Introduce the topic naturally.

REMEMBER: Stay under ${estimatedWords} words total.`;

        const interaction = await this.withRetry(() =>
            ai.interactions.create({
                model: GEMINI_MODELS.PODCAST,
                input: prompt,
                store: false,
            }),
        );

        let script = interaction.output_text || '';

        // Validate script length against TTS token limit
        const scriptTokens = this.estimateTokens(script);
        const maxTtsTokens = ttsTokenLimits[duration];

        console.log(`📝 Generated script: ${scriptTokens} tokens (limit: ${maxTtsTokens})`);

        if (scriptTokens > maxTtsTokens) {
            console.warn(`⚠️ Script exceeds TTS limit! Truncating from ${scriptTokens} to ~${maxTtsTokens} tokens`);

            // Emergency truncation - split by speaker lines and keep only what fits
            const lines = script.split('\n').filter((line) => line.trim());
            const truncatedLines: string[] = [];
            let currentTokens = 0;

            for (const line of lines) {
                const lineTokens = this.estimateTokens(line);
                if (currentTokens + lineTokens > maxTtsTokens - 100) {
                    // Leave 100 token buffer
                    break;
                }
                truncatedLines.push(line);
                currentTokens += lineTokens;
            }

            script = truncatedLines.join('\n');
            console.log(`✂️ Truncated to ${truncatedLines.length} lines, ~${currentTokens} tokens`);
        }

        const scriptInputTokens = interaction.usage?.total_input_tokens ?? this.estimateTokens(prompt);
        const scriptOutputTokens = interaction.usage?.total_output_tokens ?? this.estimateTokens(script);
        const costs = this.calculateCost(scriptInputTokens, scriptOutputTokens, true);

        console.log(`=== AI PODCAST SCRIPT COST ===`);
        console.log(`Model: gemini-3-flash-preview`);
        console.log(`Persona: ${personaId}`);
        console.log(`💰 Total cost: $${costs.totalCost.toFixed(6)}`);
        console.log(`📊 Tokens: ${(scriptInputTokens + scriptOutputTokens).toLocaleString()}`);
        console.log(`==============================`);

        return script;
    }

    /**
     * Generates multi-speaker audio using Gemini's new multi-speaker TTS (Pro users only)
     * Following the official Gemini API documentation format
     */
    async generatePodcastAudio(
        script: string,
        isProUser: boolean = false,
        voicePair?: string,
    ): Promise<{
        audioBuffer: Buffer;
        cost: number;
        format?: string;
        mimeType?: string;
    }> {
        if (!isProUser) {
            throw new Error('Podcast generation is a Pro-only feature. Please upgrade to access multi-speaker audio.');
        }

        const ai = this.getAiClient();

        // Parse voice pair selection (default to zephyr-charon)
        const selectedPair = voicePair || 'zephyr-charon';
        const [speaker1Voice, speaker2Voice] = selectedPair.split('-');
        const speaker1Name = speaker1Voice.charAt(0).toUpperCase() + speaker1Voice.slice(1);
        const speaker2Name = speaker2Voice.charAt(0).toUpperCase() + speaker2Voice.slice(1);

        // Use correct TTS model from documentation
        const model = GEMINI_MODELS.TTS_MULTI;

        console.log(`🎙️ Generating multi-speaker podcast audio with ${model} (Pro user)`);
        console.log(`   🎤 Speaker1: ${speaker1Name}, Speaker2: ${speaker2Name}`);

        // Split script into chunks to prevent audio degradation
        // Target ~2-2.5 minutes per chunk to avoid quality issues with long generations
        // 2.5 mins * 150 wpm = 375 words * 1.3 tokens/word ≈ 500 tokens
        const chunks = this.audioProcessingService.splitScriptIntoChunks(script, 500);
        console.log(`📦 Script split into ${chunks.length} chunks for high-quality generation`);

        const pcmBuffers: Buffer[] = [];
        let finalMimeType = '';
        let totalCost = 0;

        try {
            console.log(`⚡ Generating all ${chunks.length} audio chunks in parallel...`);
            const chunkResults = await Promise.all(
                chunks.map(async (chunk, i) => {
                    console.log(`⏳ Generating audio for chunk ${i + 1}/${chunks.length}...`);
                    const response = await this.withRetry(() =>
                        ai.models.generateContent({
                            model,
                            contents: chunk,
                            config: {
                                responseModalities: ['AUDIO'],
                                speechConfig: {
                                    // Voice selection based on user's choice
                                    multiSpeakerVoiceConfig: {
                                        speakerVoiceConfigs: [
                                            {
                                                speaker: 'Speaker1',
                                                voiceConfig: {
                                                    prebuiltVoiceConfig: {
                                                        voiceName: speaker1Name,
                                                    },
                                                },
                                            },
                                            {
                                                speaker: 'Speaker2',
                                                voiceConfig: {
                                                    prebuiltVoiceConfig: {
                                                        voiceName: speaker2Name,
                                                    },
                                                },
                                            },
                                        ],
                                    },
                                },
                            },
                        }),
                    );

                    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
                    const mimeType = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.mimeType;

                    if (!audioData) {
                        throw new Error(`No audio data received for chunk ${i + 1}`);
                    }

                    return { i, pcm: Buffer.from(audioData, 'base64'), mimeType: mimeType || '', cost: this.calculateTTSCost(chunk.length, true) };
                }),
            );

            // Results arrive in order (Promise.all preserves order), but sort defensively
            chunkResults.sort((a, b) => a.i - b.i);
            for (const result of chunkResults) {
                pcmBuffers.push(result.pcm);
                if (!finalMimeType) finalMimeType = result.mimeType;
                totalCost += result.cost;
            }

            const audioBuffer = Buffer.concat(pcmBuffers);

            // Log audio format details
            console.log(`🎵 Audio format details:`);
            console.log(`   📄 MIME type: ${finalMimeType || 'unknown'}`);
            console.log(`   📦 Total Buffer size: ${(audioBuffer.length / 1024).toFixed(1)} KB`);
            console.log(`   🔍 First 16 bytes (hex): ${audioBuffer.slice(0, 16).toString('hex')}`);

            // Check if this is raw PCM audio that needs conversion
            const isPCM = finalMimeType?.includes('pcm') || finalMimeType?.includes('L16');

            if (isPCM) {
                console.log(`🔄 Detected raw PCM audio - conversion needed`);
                console.log(`   🔄 Converting PCM to AAC...`);

                // Extract PCM parameters from MIME type
                const pcmParams = this.audioProcessingService.parsePCMParams(finalMimeType || '');
                console.log(`   📊 PCM params:`, pcmParams);

                // Convert PCM to M4A
                const m4aBuffer = await this.audioProcessingService.convertPCMToFormat(audioBuffer, pcmParams, 'm4a');
                console.log(`   ✅ PCM converted to M4A: ${(m4aBuffer.length / 1024).toFixed(1)} KB`);

                return {
                    audioBuffer: m4aBuffer,
                    cost: totalCost,
                    format: 'm4a',
                    mimeType: 'audio/mp4',
                };
            } else {
                // Detect audio format by checking magic numbers for standard formats
                const audioFormat = this.audioProcessingService.detectAudioFormat(audioBuffer);
                console.log(`   🎧 Detected format: ${audioFormat}`);

                return {
                    audioBuffer,
                    cost: totalCost,
                    format: audioFormat,
                    mimeType: finalMimeType || this.audioProcessingService.getMimeTypeForFormat(audioFormat),
                };
            }
        } catch (error) {
            console.error('❌ Multi-speaker audio generation failed:', error);
            throw error;
        }
    }

    /**
     * Generates speech from text using Google Cloud TTS (Neural2) for high quality
     * or falls back to Gemini Flash TTS for cost efficiency.
     */
    async generateSpeech(
        text: string,
        isProUser: boolean = false,
        options: {
            voice?: 'Puck' | 'Charon' | 'Kore' | 'Fenrir';
            speed?: number; // 0.25 to 4.0
            format?: 'm4a' | 'wav';
        } = {},
    ): Promise<{
        audioBuffer: Buffer;
        format: string;
        duration?: number;
        cost: number;
        model: string;
    }> {
        // Default options
        const { voice = 'Puck', speed = 1.0, format = 'm4a' } = options;

        // Validate text length
        // Google Cloud TTS is available for ALL users (Pro gets higher limits if needed, but we keep it generous)
        const maxLength = isProUser ? 10000 : 5000;
        if (text.length > maxLength) {
            throw new Error(`Text too long for ${isProUser ? 'Pro' : 'Free'} tier. Maximum ${maxLength} characters allowed.`);
        }

        // Google Cloud TTS (Standard Voices) Implementation
        // Available for ALL users. No Gemini fallback.
        // Cost: $4.00/1M characters (Cheapest option)

        // Ensure we have the key file configured
        if (!process.env.GOOGLE_CLOUD_TTS_KEY_FILE) {
            throw new Error('Google Cloud TTS key is not configured. Cannot generate speech.');
        }

        try {
            const client = this.getGoogleCloudTtsClient();
            const config = this.getGoogleCloudVoice(voice);

            console.log(`🎙️ [Google Cloud TTS] Generating speech using STANDARD voices ($4/1M chars):`);
            console.log(`   📝 Text length: ${text.length} characters`);
            console.log(`   🎵 Voice: ${config.name} (${voice}), Speed: ${speed}x`);

            const request = {
                input: { text: text },
                voice: { languageCode: 'en-US', name: config.name, ssmlGender: config.ssmlGender },
                audioConfig: {
                    audioEncoding: format === 'wav' ? 'LINEAR16' : 'MP3',
                    speakingRate: speed,
                    pitch: 0,
                },
            };

            // @ts-ignore - types mismatch between loopback's injection and actual client sometimes
            const [response] = await client.synthesizeSpeech(request);
            const audioContent = response.audioContent;

            if (!audioContent) {
                throw new Error('No audio content received from Google Cloud TTS');
            }

            const audioBuffer = Buffer.from(audioContent);

            // Calculate cost: Standard is $4.00 per 1M characters
            const cost = (text.length / 1000000) * 4.0;

            // Estimate duration (rough calculation)
            const wordCount = text.split(/\s+/).length;
            const estimatedDuration = (wordCount / 150) * 60; // seconds

            console.log(`✅ [Google Cloud TTS] Generation completed using Standard voice:`);
            console.log(`   🔊 Audio size: ${(audioBuffer.length / 1024).toFixed(1)} KB`);
            console.log(`   💰 Cost: $${cost.toFixed(6)}`);

            return {
                audioBuffer,
                format: 'm4a',
                duration: estimatedDuration,
                cost,
                model: 'google-cloud-tts-standard',
            };
        } catch (error: any) {
            console.error('❌ Google Cloud TTS failed:', error);
            throw error; // Re-throw error, no fallback
        }
    }

    /**
     * Generates speech specifically for article summaries.
     * Optimizes text for better TTS output.
     */
    async generateSummaryAudio(
        articleId: string,
        summaryText: string,
        isProUser: boolean = false,
        options: {
            voice?: 'Puck' | 'Charon' | 'Kore' | 'Fenrir';
            speed?: number;
            language?: string; // Add language support
        } = {},
    ): Promise<{
        audioBuffer: Buffer;
        format: string;
        duration?: number;
        cost: number;
        model: string;
    }> {
        console.log(`🎙️[TTS] Generating audio for article ${articleId} summary`);

        const language = options.language || 'en';

        // Optimize summary text for TTS (pass language to avoid bad English fixes on Spanish text)
        const optimizedText = this.optimizeTextForTTS(summaryText, language);

        // Use default voice optimized for article reading
        const ttsOptions = {
            voice: options.voice || 'Charon', // Charon is good for longer content
            speed: options.speed || 0.9, // Slightly slower for better comprehension
            format: 'm4a' as const,
        };

        const result = await this.generateSpeech(optimizedText, isProUser, ttsOptions);

        console.log(`✅[TTS] Summary audio generated for article ${articleId}`);
        return result;
    }

    /**
     * Suggests existing collections that might be a good fit for a specific article.
     *
     * @param articleInfo - The title and content/summary of the article.
     * @param collectionNames - A list of the user's existing collection names.
     * @param isProUser - Whether the user is a Pro user (affects model choice).
     * @returns A promise that resolves to an array of suggested collection names.
     */
    async suggestCollectionsForArticle(
        articleInfo: { title: string; content: string },
        collectionNames: string[],
        isProUser: boolean = false,
    ): Promise<string[]> {
        if (!collectionNames || collectionNames.length === 0) {
            return [];
        }

        const ai = this.getAiClient();

        // Truncate content to avoid excessive token usage
        const maxContentLength = 1000;
        const truncatedContent =
            articleInfo.content.length > maxContentLength ? articleInfo.content.substring(0, maxContentLength) + '...' : articleInfo.content;

        const prompt = `
      I have an article and a list of existing collections.
      Please suggest which of the existing collections this article would fit into best.

      Article Title: "${articleInfo.title}"
      Article Content Snippet: "${truncatedContent}"

      Existing Collections:
      ${collectionNames.map((name) => `- ${name}`).join('\n')}

Instructions:
1. Select the most relevant collections from the list provided.
      2. If the article fits into multiple collections, list them all(up to 3).
      3. If it doesn't fit well into any, return an empty array.
4. Return ONLY a JSON array of strings(collection names).

      Example output: ["Tech News", "Reading List"]
  `;

        const inputTokens = this.estimateTokens(prompt);

        // Use FREE_TEXT model for efficiency as this is a simple classification task
        const model = GEMINI_MODELS.FREE_TEXT;

        try {
            const interaction = await this.withRetry(() =>
                ai.interactions.create({
                    model,
                    input: prompt,
                    store: false,
                }),
            );

            const responseText = interaction.output_text || '[]';
            const outputTokens = interaction.usage?.total_output_tokens ?? this.estimateTokens(responseText);
            const actualInputTokens = interaction.usage?.total_input_tokens ?? inputTokens;
            const costs = this.calculateCost(actualInputTokens, outputTokens, false);

            console.log(`=== AI COLLECTION SUGGESTION COST === `);
            console.log(`Model: ${model} `);
            console.log(`💰 Total cost: $${costs.totalCost.toFixed(6)} `);
            console.log(`📊 Tokens: ${(actualInputTokens + outputTokens).toLocaleString()} `);
            console.log(`=====================================`);

            const cleanResponse = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
            const suggestions = JSON.parse(cleanResponse);

            return Array.isArray(suggestions) ? suggestions : [];
        } catch (error) {
            console.error('Failed to suggest collections:', error);
            return [];
        }
    }

    /**
     * Suggests new collections based on a list of articles.
     *
     * @param articles - A list of articles (title and optional summary).
     * @param isProUser - Whether the user is a Pro user.
     * @returns A promise that resolves to an array of suggested collections (name, emoji, reason).
     */
    async suggestNewCollections(
        articles: { title: string; summary?: string }[],
        isProUser: boolean = false,
    ): Promise<{ name: string; emoji: string; reason: string }[]> {
        if (!articles || articles.length === 0) {
            return [];
        }

        const ai = this.getAiClient();

        // Limit to last 20 articles to keep context manageable
        const recentArticles = articles.slice(0, 20);
        const articlesList = recentArticles
            .map((a) => `- "${a.title}"${a.summary ? `: ${a.summary.substring(0, 100)}...` : ''} `)
            .join('\n');

        const prompt = `
      Here is a list of articles a user has saved.
  Suggest 3 - 5 new collections that would help organize these articles effectively.

    Articles:
      ${articlesList}

Instructions:
1. Identify common themes or topics.
      2. Suggest collection names that are concise and descriptive.
      3. Choose a relevant emoji for each collection.
      4. Provide a brief reason for the suggestion.
      5. Return ONLY a JSON array of objects.

      Example format:
[
  {
    "name": "AI & Tech",
    "emoji": "🤖",
    "reason": "Several articles about artificial intelligence and technology trends."
  }
]
  `;

        const inputTokens = this.estimateTokens(prompt);
        const model = this.getModel(isProUser); // Use Pro model for better reasoning if available

        try {
            const interaction = await this.withRetry(() =>
                ai.interactions.create({
                    model,
                    input: prompt,
                    store: false,
                }),
            );

            const responseText = interaction.output_text || '[]';
            const outputTokens = interaction.usage?.total_output_tokens ?? this.estimateTokens(responseText);
            const actualInputTokens = interaction.usage?.total_input_tokens ?? inputTokens;
            const costs = this.calculateCost(actualInputTokens, outputTokens, isProUser);

            console.log(`=== AI NEW COLLECTION SUGGESTION COST === `);
            console.log(`Model: ${model} `);
            console.log(`💰 Total cost: $${costs.totalCost.toFixed(6)} `);
            console.log(`📊 Tokens: ${(actualInputTokens + outputTokens).toLocaleString()} `);
            console.log(`========================================= `);

            const cleanResponse = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
            const suggestions = JSON.parse(cleanResponse);

            return Array.isArray(suggestions) ? suggestions : [];
        } catch (error) {
            console.error('Failed to suggest new collections:', error);
            return [];
        }
    }

    /**
     * Calculates TTS costs based on character count and user tier.
     * Updated for Pro-only podcast feature using Flash model.
     */
    private calculateTTSCost(characterCount: number, isProUser: boolean): number {
        // Gemini 2.5 Flash Audio pricing: ~$10.00 per 1M audio tokens
        // 1M characters ≈ 1.6M audio tokens ≈ $16.00
        // We normalize to character count for easier comparison with Google Cloud TTS ($16.00)
        const ratePerCharacter = 16.0 / 1000000;

        return characterCount * ratePerCharacter;
    }

    /**
     * Gets available TTS voices for the user's tier.
     */
    getTTSVoices(isProUser: boolean = false): {
        voice: string;
        description: string;
        recommended: string;
    }[] {
        const voices = [
            {
                voice: 'Puck',
                description: 'Expressive and dynamic voice, good for engaging content',
                recommended: 'News articles, blog posts',
            },
            {
                voice: 'Charon',
                description: 'Clear and measured voice, ideal for longer content',
                recommended: 'Academic papers, detailed summaries',
            },
            {
                voice: 'Kore',
                description: 'Warm and friendly voice, great for casual content',
                recommended: 'Personal stories, informal articles',
            },
            {
                voice: 'Fenrir',
                description: 'Authoritative and professional voice',
                recommended: 'Business content, formal reports',
            },
        ];

        // Pro users get access to all voices, Free users get limited selection
        return isProUser ? voices : voices.slice(0, 2);
    }

    /**
     * Splits text into chunks of a specified size with overlap.
     * Useful for processing large texts that exceed token limits.
     *
     * @param text - The text to chunk.
     * @param chunkSize - The maximum number of characters per chunk (default: 4000).
     * @param overlap - The number of characters to overlap between chunks (default: 200).
     * @returns An array of text chunks.
     */
    public chunkText(text: string, chunkSize: number = 4000, overlap: number = 200): string[] {
        if (!text) return [];

        const chunks: string[] = [];
        let i = 0;

        while (i < text.length) {
            let limit = Math.min(i + chunkSize, text.length);

            // If we are not at the end, try to find a good break point
            if (limit < text.length) {
                // 1. Try to break at a paragraph or sentence end
                const lastSentenceEnd = Math.max(
                    text.lastIndexOf('.\n', limit),
                    text.lastIndexOf('. ', limit),
                    text.lastIndexOf('? ', limit),
                    text.lastIndexOf('! ', limit),
                );

                // If we found a sentence end reasonably close to the limit (e.g., within last 20%)
                if (lastSentenceEnd !== -1 && lastSentenceEnd > limit - chunkSize * 0.2) {
                    limit = lastSentenceEnd + 1;
                } else {
                    // 2. Fallback: Break at the last space to avoid splitting words
                    const lastSpace = text.lastIndexOf(' ', limit);
                    // Only use lastSpace if it's after the current start 'i'
                    if (lastSpace !== -1 && lastSpace > i) {
                        limit = lastSpace;
                    }
                    // If no space found (e.g. huge URL), we are forced to split hard at 'limit'
                }
            }

            const chunk = text.substring(i, limit).trim();
            if (chunk) chunks.push(chunk);

            // If we reached the end, stop
            if (limit >= text.length) break;

            // Calculate next start position with overlap
            // We want to start 'overlap' characters before the current 'limit'
            let nextStart = limit - overlap;

            // Ensure we don't get stuck or go backwards too far
            if (nextStart <= i) {
                // If overlap is larger than the chunk we just made, just advance by 1/2 chunk or something safe
                nextStart = i + Math.floor(chunk.length / 2);
            }

            // Align nextStart to the beginning of a word (find space before)
            const spaceBeforeNext = text.lastIndexOf(' ', nextStart);
            if (spaceBeforeNext !== -1 && spaceBeforeNext > i) {
                nextStart = spaceBeforeNext + 1;
            }

            i = nextStart;
        }

        return chunks;
    }

    /**
     * Optimizes text for better TTS pronunciation and flow.
     */
    private optimizeTextForTTS(text: string, language: string = 'en'): string {
        let optimized = text
            // Common cleanups (universal)
            .replace(/#{1,6}\s/g, '') // Remove markdown headers
            .replace(/\*\*(.*?)\*\*/g, '$1') // Remove bold markdown
            .replace(/\*(.*?)\*/g, '$1') // Remove italic markdown
            .replace(/\s+/g, ' ')
            .trim();

        // Only apply pronunciation fixes for English
        if (language.startsWith('en')) {
            optimized = optimized
                .replace(/\bAI\b/g, 'A.I.')
                .replace(/\bAPI\b/g, 'A.P.I.')
                .replace(/\bURL\b/g, 'U.R.L.')
                .replace(/\bCEO\b/g, 'C.E.O.')
                .replace(/\bCTO\b/g, 'C.T.O.')
                .replace(/\. /g, '. ... ') // Add pause after sentences
                .replace(/: /g, ': ... ') // Add pause after colons
                .replace(/(\d+)%/g, '$1 percent') // "50%" becomes "50 percent"
                .replace(/\$(\d+)/g, '$1 dollars'); // "$100" becomes "100 dollars"
        }

        return optimized;
    }

    /**
     * Generates a prompt for creating a technical visualization based on the provided text and context.
     *
     * @param text - The text to visualize.
     * @param context - The surrounding context.
     * @param style - The desired style (blueprint, hand-drawn, knolling).
     * @returns The generated prompt string.
     */
    async generateVisualPrompt(text: string, context: string, style: string): Promise<string> {
        const prompt = `
      You are an expert technical illustrator.
      Create a detailed image generation prompt for a technical visualization of the following concept.

      ** Concept to Visualize **: "${text}"
  ** Context **: "${context}"
    ** Target Style **: ${style}

      ** CRITICAL "ANTI-SLOP" CONSTRAINTS **:
1. NO photorealism.The image must look like a diagram, blueprint, or sketch.
      2. NO human faces or realistic human figures.Use abstract avatars or stick figures if necessary.
      3. NO text generation inside the image.Do not attempt to write labels.
      4. The style must be abstract, technical, or educational.
      5. ${style === 'blueprint' ? 'Use technical blueprint style with grid lines and white lines on blue background.' : ''}
6. ${style === 'hand-drawn' ? 'Use loose, hand-drawn whiteboard sketch style.' : ''}
7. ${style === 'knolling' ? 'Use flat-lay knolling photography style of objects arranged in parallel/90-degree angles.' : ''}

      Output ONLY the prompt string to be fed into the image generator.
    `;

        const result = await this.generateContent(prompt, false);
        return result || '';
    }

    /**
     * Generates an image using the Gemini Image model.
     *
     * @param prompt - The prompt to use.
     * @returns The image data buffer.
     */
    async generateVisualizationImage(prompt: string): Promise<Buffer> {
        const ai = this.getAiClient();
        try {
            const model = GEMINI_MODELS.IMAGE;

            const interaction = await this.withRetry(() =>
                ai.interactions.create({
                    model,
                    input: prompt,
                    store: false,
                }),
            );

            // SDK convenience property for image output
            if (interaction.output_image?.data) {
                return Buffer.from(interaction.output_image.data, 'base64');
            }

            // Fallback: iterate steps for image content
            for (const step of interaction.steps || []) {
                if (step.type === 'model_output') {
                    for (const block of (step as any).content || []) {
                        if (block.type === 'image' && block.data) {
                            return Buffer.from(block.data, 'base64');
                        }
                    }
                }
            }

            throw new Error('No image data found in interaction response');
        } catch (e: any) {
            console.error('Image generation failed:', e);
            throw new Error(`Image generation failed: ${e.message}`);
        }
    }

    /**
     * Sends a chat message within an article conversation.
     * On the first turn, sends the full context prompt (article + system instruction).
     * On subsequent turns, sends only the user message using server-side state via
     * previous_interaction_id — avoiding resending the full conversation history.
     */
    async generateChatMessage(params: {
        message: string;
        fullContextPrompt: string;
        previousInteractionId?: string;
    }): Promise<{ response: string; interactionId: string }> {
        const ai = this.getAiClient();

        const isFirstTurn = !params.previousInteractionId;

        const createParams: Record<string, unknown> = {
            model: GEMINI_MODELS.FREE_TEXT,
            input: isFirstTurn ? params.fullContextPrompt : params.message,
            // store defaults to true — required for previous_interaction_id to work
        };

        if (params.previousInteractionId) {
            createParams.previous_interaction_id = params.previousInteractionId;
        }

        const interaction = await this.withRetry(() => ai.interactions.create(createParams as any));

        return {
            response: interaction.output_text || '',
            interactionId: interaction.id || '',
        };
    }

    async generateResearchReport(
        query: string,
        articles: { id: string; title: string; excerpt?: string; content?: string }[],
        chunks?: { articleTitle: string; chunkText: string }[],
    ): Promise<string> {
        const ai = this.getAiClient();

        // Build context from chunks (preferred) or fallback to truncated articles
        let sourceContext: string;
        if (chunks?.length) {
            // Group chunks by article title for structured context
            const byArticle = new Map<string, string[]>();
            for (const c of chunks) {
                const existing = byArticle.get(c.articleTitle) || [];
                existing.push(c.chunkText.substring(0, 1500));
                byArticle.set(c.articleTitle, existing);
            }
            sourceContext = Array.from(byArticle.entries())
                .map(([title, texts], i) => {
                    const articleNum = articles.findIndex((a) => a.title === title) + 1 || i + 1;
                    return `[Article ${articleNum}] "${title}"\n${texts.join('\n\n')}`;
                })
                .join('\n\n---\n\n');
        } else {
            const maxPerArticle = 2000;
            sourceContext = articles
                .map((a, i) => {
                    const snippet = (a.content || a.excerpt || '').substring(0, maxPerArticle);
                    return `[Article ${i + 1}] "${a.title}" (id: ${a.id})\n${snippet}`;
                })
                .join('\n\n---\n\n');
        }

        const prompt = `You are a research assistant. The user wants to understand a topic based on articles they have saved.

USER QUERY: "${query}"

ARTICLES FROM THE USER'S LIBRARY:
${sourceContext}

INSTRUCTIONS:
1. Synthesize the information from these articles into a clear, structured research report that answers the user's query.
2. Cite articles using short numbered references like [1], [2], [3] inline. Do NOT include article titles in inline citations.
3. If articles present conflicting viewpoints, highlight the disagreement.
4. If the articles don't sufficiently cover the query, say so honestly.
5. Do NOT invent information that isn't in the provided articles.

FORMAT:
## Key Findings
[2-4 bullet points summarizing the main insights]

## Detailed Analysis
[Structured paragraphs with inline [1], [2] citations]

## Sources
[List each cited source as: [N] "Article Title"]`;

        const inputTokens = this.estimateTokens(prompt);

        const interaction = await this.withRetry(() =>
            ai.interactions.create({
                model: GEMINI_MODELS.FREE_TEXT,
                input: prompt,
                store: false,
            }),
        );

        const outputTokens = interaction.usage?.total_output_tokens ?? this.estimateTokens(interaction.output_text || '');
        const actualInputTokens = interaction.usage?.total_input_tokens ?? inputTokens;
        const costs = this.calculateCost(actualInputTokens, outputTokens, false);

        console.log(`=== AI RESEARCH REPORT COST ===`);
        console.log(`Model: ${costs.model}`);
        console.log(`Articles analyzed: ${articles.length}`);
        console.log(`Chunks used: ${chunks?.length ?? 0}`);
        console.log(`💰 Total cost: $${costs.totalCost.toFixed(6)}`);
        console.log(`📊 Tokens: ${(actualInputTokens + outputTokens).toLocaleString()}`);
        console.log(`================================`);

        return interaction.output_text || '';
    }
}
