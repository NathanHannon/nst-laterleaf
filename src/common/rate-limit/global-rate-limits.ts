import type { RateLimitWindow } from './rate-limit.service';

// Fixed identifier for the account-wide (not per-user) circuit breaker.
export const GLOBAL_RATE_LIMIT_KEY = 'global';

/**
 * Daily caps across ALL users combined, so a coordinated multi-account abuser
 * (or a runaway loop) can't silently exhaust Google AI Studio quota even
 * though each account stays under its own per-user burst limit.
 */
export const GLOBAL_RATE_LIMITS: Record<string, readonly RateLimitWindow[]> = {
    summary: [{ limit: 5000, windowSeconds: 86400, label: '5000 per day (global)' }],
    import: [{ limit: 5000, windowSeconds: 86400, label: '5000 per day (global)' }],
    audio: [{ limit: 1000, windowSeconds: 86400, label: '1000 per day (global)' }],
    podcast: [{ limit: 300, windowSeconds: 86400, label: '300 per day (global)' }],
    translate: [{ limit: 2000, windowSeconds: 86400, label: '2000 per day (global)' }],
    chat: [{ limit: 2000, windowSeconds: 86400, label: '2000 per day (global)' }],
};
