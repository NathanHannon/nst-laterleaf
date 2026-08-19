import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { RateLimitExceededException } from './rate-limit-exceeded.exception';

export interface RateLimitWindow {
    limit: number;
    windowSeconds: number;
    label: string;
}

/**
 * Postgres-backed fixed-window rate limiter using the main TypeORM DataSource
 * (public.rate_limits). Decoupled from pg-boss so its queue pool is not
 * contended by per-request rate-limit checks.
 *
 * Same atomic INSERT ... ON CONFLICT ... RETURNING semantics as before,
 * but on public schema via DataSource.query().
 */
@Injectable()
export class RateLimitService implements OnModuleInit {
    private readonly logger = new Logger(RateLimitService.name);

    constructor(private readonly dataSource: DataSource) { }

    async onModuleInit(): Promise<void> {
        // Ensure table exists even if migrations haven't run (e.g. fresh dev DB).
        // Production should also have the SQL migration in sql/migrations/.
        await this.dataSource.query(`
            CREATE TABLE IF NOT EXISTS rate_limits (
                key        TEXT        PRIMARY KEY,
                count      INT         NOT NULL DEFAULT 0,
                reset_at   TIMESTAMPTZ NOT NULL
            )
        `);
        // Keeps the cleanup sweep from seq-scanning the table.
        await this.dataSource.query(
            `CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON rate_limits (reset_at)`,
        );
    }

    /**
     * Atomic fixed-window check. Safe across instances/restarts.
     */
    async checkRateLimit(
        keyIdentifier: string,
        action: string,
        limit: number,
        windowSeconds: number,
    ): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
        const key = RateLimitService.buildKey(action, keyIdentifier);
        const rows = await this.dataSource.query(
            `INSERT INTO rate_limits (key, count, reset_at)
             VALUES ($1, 1, NOW() + ($2::int * INTERVAL '1 second'))
             ON CONFLICT (key) DO UPDATE
               SET count    = CASE
                                WHEN rate_limits.reset_at <= NOW() THEN 1
                                ELSE rate_limits.count + 1
                              END,
                   reset_at = CASE
                                WHEN rate_limits.reset_at <= NOW()
                                THEN NOW() + ($2::int * INTERVAL '1 second')
                                ELSE rate_limits.reset_at
                              END
             RETURNING count, EXTRACT(EPOCH FROM (reset_at - NOW()))::INT AS reset_in`,
            [key, windowSeconds],
        );
        const row = rows[0] as { count: number; reset_in: number };
        return {
            allowed: row.count <= limit,
            remaining: Math.max(0, limit - row.count),
            resetIn: row.reset_in,
        };
    }

    /**
     * Enforces every window for an action, throwing 429 on the first breach.
     *
     * `failOpen` allows the request through when the limiter itself errors — keep it
     * on for cheap endpoints, off for anything that spends money per call.
     */
    async enforce(
        keyIdentifier: string,
        action: string,
        windows: readonly RateLimitWindow[],
        options: { failOpen?: boolean } = {},
    ): Promise<void> {
        const failOpen = options.failOpen ?? true;
        const consumedKeys: string[] = [];

        for (const { limit, windowSeconds, label } of windows) {
            const scopedAction = `${action}:${windowSeconds}s`;
            let result: { allowed: boolean; remaining: number; resetIn: number };

            try {
                result = await this.checkRateLimit(keyIdentifier, scopedAction, limit, windowSeconds);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                if (!failOpen) {
                    this.logger.error(`Rate limiter unavailable for ${action}, rejecting request: ${reason}`);
                    throw new ServiceUnavailableException('Rate limiter unavailable. Please retry shortly.');
                }
                this.logger.warn(`Rate limiter check failed for ${action}, allowing request: ${reason}`);
                return;
            }

            if (!result.allowed) {
                this.logger.warn(`Rate limit hit: key=${keyIdentifier} action=${action} ${label} retryAfter=${result.resetIn}s`);
                // The breached window keeps its increment; earlier windows are refunded so a
                // rejected request does not burn quota in the windows that still allowed it.
                await this.refund(consumedKeys);
                throw new RateLimitExceededException(
                    `Rate limit exceeded: ${label} for ${action}. Try again in ${result.resetIn}s.`,
                    result.resetIn,
                );
            }

            consumedKeys.push(RateLimitService.buildKey(scopedAction, keyIdentifier));
        }
    }

    private async refund(keys: string[]): Promise<void> {
        if (keys.length === 0) return;
        try {
            await this.dataSource.query(
                `UPDATE rate_limits SET count = GREATEST(count - 1, 0) WHERE key = ANY($1)`,
                [keys],
            );
        } catch (error) {
            this.logger.warn(`Failed to refund rate limit counters: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private static buildKey(action: string, keyIdentifier: string): string {
        return `ratelimit:${action}:${keyIdentifier}`;
    }

    /**
     * Deletes expired rows to prevent unbounded growth.
     */
    @Cron('15 * * * *', { name: 'cleanup-rate-limits' })
    async cleanupRateLimits(): Promise<void> {
        // RETURNING so the deleted count is available (DataSource.query yields rows, not rowCount).
        const deleted: unknown[] = await this.dataSource.query(
            `DELETE FROM rate_limits WHERE reset_at < NOW() RETURNING key`,
        );
        this.logger.log(`Cleaned up ${deleted.length} expired rate limit rows.`);
    }
}
