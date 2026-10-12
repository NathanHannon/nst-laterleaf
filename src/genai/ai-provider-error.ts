import { HttpException } from '@nestjs/common';

export const AI_PROVIDER_CREDITS_EXHAUSTED = 'AI_PROVIDER_CREDITS_EXHAUSTED';
export const AI_PROVIDER_CREDITS_EXHAUSTED_MESSAGE =
    'AI generation is temporarily unavailable because the provider account has no available credits. Please try again later.';

const BILLING_ERROR_CODES = new Set([
    'billing_hard_limit_reached',
    'billing_not_active',
    'credit_balance_too_low',
    'credits_exhausted',
    'insufficient_quota',
    'payment_required',
]);

const BILLING_ERROR_MESSAGE = /insufficient[_\s-]?quota|billing[_\s-]?(?:hard[_\s-]?limit|not[_\s-]?active)|(?:credit|credits|balance).{0,50}(?:exhausted|depleted|insufficient|too low|negative)|(?:exhausted|depleted|insufficient).{0,50}(?:credit|credits|balance)|check (?:your|the) plan and billing|billing (?:account|is|has)|payment required/i;

export function normalizeAiProviderError(error: unknown): unknown {
    const candidates = getErrorCandidates(error);
    const status = candidates
        .map((candidate) => candidate.status ?? candidate.statusCode)
        .find((value) => value !== undefined);
    const code = candidates
        .map((candidate) => candidate.code ?? candidate.type)
        .find((value) => typeof value === 'string');
    const message = candidates
        .map((candidate) => candidate.message)
        .filter((value): value is string => typeof value === 'string')
        .join(' ');

    const normalizedCode = typeof code === 'string' ? code.toLowerCase() : '';
    const hasNoCredits = status === 402
        || BILLING_ERROR_CODES.has(normalizedCode)
        || BILLING_ERROR_MESSAGE.test(message);

    if (!hasNoCredits) return error;

    return new HttpException({
        statusCode: 402,
        error: {
            code: AI_PROVIDER_CREDITS_EXHAUSTED,
            message: AI_PROVIDER_CREDITS_EXHAUSTED_MESSAGE,
        },
    }, 402);
}

function getErrorCandidates(error: unknown): Array<Record<string, unknown>> {
    if (!error || typeof error !== 'object') return [];

    const root = error as Record<string, unknown>;
    const response = root.response && typeof root.response === 'object'
        ? root.response as Record<string, unknown>
        : undefined;
    const responseData = response?.data && typeof response.data === 'object'
        ? response.data as Record<string, unknown>
        : undefined;
    const nestedError = root.error && typeof root.error === 'object'
        ? root.error as Record<string, unknown>
        : undefined;
    const responseError = responseData?.error && typeof responseData.error === 'object'
        ? responseData.error as Record<string, unknown>
        : undefined;

    return [root, nestedError, response, responseData, responseError]
        .filter((candidate): candidate is Record<string, unknown> => Boolean(candidate));
}