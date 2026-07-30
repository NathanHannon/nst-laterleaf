import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgBoss } from 'pg-boss';

/**
 * Ports lb-laterleaf/src/services/job-queue.service.ts. Wraps pg-boss
 * (Postgres-backed job queue) for the summary-pro, audio-generation, and
 * article-chunking queues, plus an atomic Postgres-backed rate limiter.
 *
 * Uses OnModuleInit/OnModuleDestroy as the Nest equivalent of LB's
 * `@lifeCycleObserver('services')` group. A startPromise guard is kept
 * since JobWorkerService also calls start() explicitly before registering
 * workers (pg-boss's own start() is idempotent, but this avoids redundant
 * work and matches the original's defensive pattern).
 */
@Injectable()
export class JobQueueService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(JobQueueService.name);
    private boss: PgBoss;
    private startPromise: Promise<void> | null = null;

    /**
     * Resolves SSL config for pg-boss's internal Postgres connection.
     * Priority:
     *  1. DATABASE_CA_CERT env var (base64-encoded) — set on App Platform / CI
     *  2. Local cert file — used in development
     *  3. rejectUnauthorized: false — fallback for trusted internal networks
     */
    private static buildSslConfig(): object {
        if (process.env.DATABASE_CA_CERT) {
            return { ca: Buffer.from(process.env.DATABASE_CA_CERT, 'base64').toString() };
        }
        const certPath = path.join(__dirname, '../../../certs/laterleaf-db-ca-certificate.crt');
        if (fs.existsSync(certPath)) {
            return { ca: fs.readFileSync(certPath).toString() };
        }
        return { rejectUnauthorized: false };
    }

    constructor() {
        this.boss = new PgBoss({
            host: process.env.DATABASE_HOST,
            port: parseInt(process.env.DATABASE_PORT ?? '25060'),
            user: process.env.DATABASE_USER,
            password: process.env.DATABASE_PASSWORD,
            database: process.env.DATABASE_NAME,
            ssl: JobQueueService.buildSslConfig(),
            // Cap pg-boss's internal pool to leave headroom for TypeORM's own pool.
            max: 3,
        });

        this.boss.on('error', (err: Error) => {
            this.logger.error(`pg-boss error: ${err.message}`, err.stack);
        });
    }

    async onModuleInit(): Promise<void> {
        await this.start();
    }

    async onModuleDestroy(): Promise<void> {
        await this.stop();
    }

    async start(): Promise<void> {
        // If already starting or started, wait for/return the same promise.
        if (this.startPromise) return this.startPromise;
        this.startPromise = this._doStart();
        return this.startPromise;
    }

    private async _doStart(): Promise<void> {
        this.logger.log('Starting pg-boss...');
        await this.boss.start();

        // Create queues with their default options so workers inherit them automatically.
        await Promise.all([
            this.boss.createQueue('summary-pro', {
                retryLimit: 3,
                retryDelay: 2,
                retryBackoff: true,
                expireInSeconds: 120,
            }),
            this.boss.createQueue('audio-generation', {
                retryLimit: 2,
                retryDelay: 5,
                retryBackoff: true,
                expireInSeconds: 600, // Audio generation can take up to 10 minutes
            }),
            this.boss.createQueue('article-chunking', {
                retryLimit: 3,
                retryDelay: 2,
                retryBackoff: true,
                expireInSeconds: 300,
            }),
        ]);

        // Create a rate_limits table for atomic, multi-instance-safe fixed-window counters.
        // Stored alongside pg-boss data; no separate migration needed.
        await this.boss.getDb().executeSql(`
      CREATE TABLE IF NOT EXISTS pgboss.rate_limits (
        key        TEXT        PRIMARY KEY,
        count      INT         NOT NULL DEFAULT 0,
        reset_at   TIMESTAMPTZ NOT NULL
      )
    `);

        this.logger.log('pg-boss started.');
    }

    async stop(): Promise<void> {
        await this.boss.stop();
        this.logger.log('pg-boss stopped.');
    }

    getBoss(): PgBoss {
        return this.boss;
    }

    /**
     * Add a summary generation job to the pro queue
     */
    async addSummaryJob(data: {
        articleId: string;
        userId: string;
        content: string;
        isPro: boolean;
        language?: string;
    }) {
        if (!data.isPro) {
            this.logger.warn('Basic summaries do not use the job queue anymore (unlimited rate).');
            return;
        }

        this.logger.log(`[Queue] Adding job to summary-pro for article ${data.articleId}`);
        await this.boss.send('summary-pro', data, { priority: 10 });
    }

    /**
     * Add an audio generation job to the audio queue
     */
    async addAudioJob(data: {
        articleId: string;
        userId: string;
        title: string;
        content: string;
        duration?: 'short' | 'medium' | 'long';
        style?: 'casual' | 'professional' | 'educational';
        voices?: string;
        personaId?: string;
        language?: string;
    }) {
        this.logger.log(`[Queue] Adding job to audio-generation for article ${data.articleId}`);
        await this.boss.send('audio-generation', data, { priority: 5 });
    }

    /**
     * Deletes expired rows from pgboss.rate_limits to prevent unbounded table growth.
     */
    async cleanupRateLimits(): Promise<void> {
        const result = await this.boss.getDb().executeSql(`DELETE FROM pgboss.rate_limits WHERE reset_at < NOW()`);
        this.logger.log(`Cleaned up ${result.rows.length} expired rate limit rows.`);
    }

    /**
     * Add a chunking job to the chunking queue
     */
    async addChunkingJob(data: { articleId: string }) {
        this.logger.log(`[Queue] Adding job to article-chunking for article ${data.articleId}`);
        await this.boss.send('article-chunking', data, { priority: 1 });
    }

    /**
     * Get statistics for all queues.
     */
    async getQueueStats() {
        const getStats = async (name: string) => {
            try {
                const [stats] = await this.boss.getQueueStats(name);
                return {
                    queued: stats?.queuedCount ?? 0,
                    active: stats?.activeCount ?? 0,
                    deferred: stats?.deferredCount ?? 0,
                    total: stats?.totalCount ?? 0,
                };
            } catch {
                return { queued: 0, active: 0, deferred: 0, total: 0 };
            }
        };

        const [pro, audio, chunking] = await Promise.all([
            getStats('summary-pro'),
            getStats('audio-generation'),
            getStats('article-chunking'),
        ]);

        return { pro, audio, chunking };
    }

    /**
     * Atomic fixed-window rate limiter backed by Postgres.
     * Safe across multiple server instances and server restarts.
     * Uses a single upsert statement to avoid race conditions.
     */
    async checkRateLimit(
        keyIdentifier: string,
        action: string,
        limit: number,
        windowSeconds: number,
    ): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
        const key = `ratelimit:${action}:${keyIdentifier}`;

        // Single atomic upsert:
        // - On first hit: insert with count=1 and a fresh window
        // - If the existing window is still active: increment count
        // - If the existing window has expired: reset count to 1 with a new window
        const result = await this.boss.getDb().executeSql(
            `INSERT INTO pgboss.rate_limits (key, count, reset_at)
       VALUES ($1, 1, NOW() + ($2 * INTERVAL '1 second'))
       ON CONFLICT (key) DO UPDATE
         SET count    = CASE
                          WHEN pgboss.rate_limits.reset_at <= NOW() THEN 1
                          ELSE pgboss.rate_limits.count + 1
                        END,
             reset_at = CASE
                          WHEN pgboss.rate_limits.reset_at <= NOW()
                          THEN NOW() + ($2 * INTERVAL '1 second')
                          ELSE pgboss.rate_limits.reset_at
                        END
       RETURNING count, EXTRACT(EPOCH FROM (reset_at - NOW()))::INT AS reset_in`,
            [key, windowSeconds],
        );

        const { count, reset_in } = result.rows[0];
        return {
            allowed: count <= limit,
            remaining: Math.max(0, limit - count),
            resetIn: reset_in,
        };
    }
}
