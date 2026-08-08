/**
 */
export const GEMINI_MODELS = {
    PRO_TEXT: 'gemini-3-flash-preview',
    FREE_TEXT: 'gemini-3.1-flash-lite',
    FALLBACK: 'gemini-3.1-flash-lite',
    EMBEDDING: 'gemini-embedding-2',
    TTS_MULTI: 'gemini-2.5-flash-preview-tts',
    PODCAST: 'gemini-3-flash-preview',
    IMAGE: 'gemini-3.1-flash-image',
} as const;

export const OPENAI_MODELS = {
    PRO_TEXT: 'gpt-5.4-mini',
    FREE_TEXT: 'gpt-5.6-luna',
    PODCAST: 'gpt-5.4-mini',
} as const;
