import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgBoss } from 'pg-boss';
import type { GenerationProviderName } from '../genai/providers/generation-provider.interface';

/**
 * Postgres-backed job queue for the summary-pro, audio-generation, and
 * article-chunking queues (pg-boss, pgboss schema).
 *
 * Rate limiting is handled separately by RateLimitService (public.rate_limits
 * via TypeORM DataSource) to avoid contending the pg-boss pool (max:3).
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
            // Must stay >= the total number of concurrent workers registered in
            // JobWorkerService, otherwise their polling fetches exhaust the pool.
            max: 10,
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
        provider?: GenerationProviderName;
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
                const waiting = (stats?.queuedCount ?? 0) + (stats?.readyCount ?? 0);
                const active = stats?.activeCount ?? 0;
                const delayed = stats?.deferredCount ?? 0;
                const failed = stats?.failedCount ?? 0;
                const total = stats?.totalCount ?? 0;
                return {
                    waiting,
                    active,
                    delayed,
                    failed,
                    completed: Math.max(0, total - waiting - active - delayed - failed),
                    paused: 0,
                };
            } catch {
                return { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, paused: 0 };
            }
        };

        const [pro, audio, chunking] = await Promise.all([
            getStats('summary-pro'),
            getStats('audio-generation'),
            getStats('article-chunking'),
        ]);

        return { pro, audio, chunking };
    }

}
