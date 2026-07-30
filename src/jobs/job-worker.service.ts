import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job } from 'pg-boss';
import { ArticlesService } from '../articles/articles.service';
import { UserArticlesService } from '../articles/user-articles.service';
import { ArticleChunksService } from '../articles/article-chunks.service';
import { GenAiService } from '../genai/gen-ai.service';
import { StorageService } from '../storage/storage.service';
import { JobQueueService } from './job-queue.service';

interface SummaryJobData {
    articleId: string;
    userId: string;
    content: string;
    isPro: boolean;
    language?: string;
}
interface AudioJobData {
    articleId: string;
    userId: string;
    title: string;
    content: string;
    duration?: 'short' | 'medium' | 'long';
    style?: 'casual' | 'professional' | 'educational';
    voices?: string;
    personaId?: string;
    language?: string;
}
interface ChunkingJobData {
    articleId: string;
}

/**
 * Ports lb-laterleaf/src/services/job-worker.service.ts. Registers pg-boss
 * workers for the summary-pro, audio-generation, and article-chunking
 * queues. Uses OnModuleInit/OnModuleDestroy as the Nest equivalent of LB's
 * `@lifeCycleObserver('services')` group.
 */
@Injectable()
export class JobWorkerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(JobWorkerService.name);

    constructor(
        private readonly jobQueueService: JobQueueService,
        private readonly genAiService: GenAiService,
        private readonly storageService: StorageService,
        private readonly userArticlesService: UserArticlesService,
        private readonly articlesService: ArticlesService,
        private readonly articleChunksService: ArticleChunksService,
    ) { }

    async onModuleInit(): Promise<void> {
        await this.start();
    }

    async onModuleDestroy(): Promise<void> {
        await this.stop();
    }

    async start(): Promise<void> {
        // Ensure the queue service (pg-boss) is fully started before registering workers.
        // pg-boss start() is idempotent — safe to call again even if already started.
        await this.jobQueueService.start();
        this.logger.log('Starting Job Workers...');
        const boss = this.jobQueueService.getBoss();

        await boss.work<SummaryJobData>(
            'summary-pro',
            { localConcurrency: 2, pollingIntervalSeconds: 0.5 },
            async (jobs: Job<SummaryJobData>[]) => {
                for (const job of jobs) await this.processSummaryJob(job.data);
            },
        );

        await boss.work<AudioJobData>(
            'audio-generation',
            { localConcurrency: 1, pollingIntervalSeconds: 0.5 },
            async (jobs: Job<AudioJobData>[]) => {
                for (const job of jobs) await this.processAudioJob(job.data);
            },
        );

        await boss.work<ChunkingJobData>(
            'article-chunking',
            { localConcurrency: 50, pollingIntervalSeconds: 0.5 },
            async (jobs: Job<ChunkingJobData>[]) => {
                for (const job of jobs) await this.processChunkingJob(job.data);
            },
        );

        this.logger.log('Job Workers started.');
    }

    private async processSummaryJob(data: SummaryJobData) {
        const { articleId, userId, content, isPro, language } = data;
        this.logger.log(`[Worker] Processing summary for article ${articleId} (Pro: ${isPro}, Lang: ${language ?? 'en'})`);
        try {
            const summary = await this.genAiService.generateSummary(content, isPro, undefined, language);
            if (summary) {
                const userArticle = await this.userArticlesService.findByUserAndArticle(userId, articleId);
                if (userArticle) {
                    await this.userArticlesService.updateById(userArticle.id, {
                        summary,
                        summaryStatus: 'completed',
                        summaryLanguage: language ?? 'en',
                    });
                    this.logger.log(`[Worker] Summary saved for ${articleId}`);
                } else {
                    this.logger.warn(`[Worker] UserArticle not found for ${articleId} (User: ${userId})`);
                }
            }
        } catch (error) {
            this.logger.error(`[Worker] Summary job failed for ${articleId}:`, error);
            throw error;
        }
    }

    private async processAudioJob(data: AudioJobData) {
        const { articleId, userId, title, content, duration, style, voices, personaId, language } = data;
        this.logger.log(`[Worker] Processing audio for article ${articleId}`);
        try {
            const script = await this.genAiService.generatePodcastScript(title, content, { duration, style, personaId, language });
            const audioResult = await this.genAiService.generatePodcastAudio(script, true, voices);
            const publicUrl = await this.storageService.uploadAudio(articleId, audioResult.audioBuffer, userId, 'podcast', {
                format: audioResult.format,
                mimeType: audioResult.mimeType,
            });
            const userArticle = await this.userArticlesService.findByUserAndArticle(userId, articleId);
            if (userArticle) {
                await this.userArticlesService.updateById(userArticle.id, {
                    audioLocation: publicUrl,
                    audioStatus: 'completed',
                    podcastScript: {
                        script,
                        generatedAt: new Date().toISOString(),
                        duration: duration ?? 'medium',
                        style: style ?? 'casual',
                        voices: voices ?? 'zephyr-charon',
                        personaId: personaId ?? 'zephyr-charon',
                        format: audioResult.format,
                        mimeType: audioResult.mimeType,
                    },
                    updatedAt: new Date(),
                });
                this.logger.log(`[Worker] Audio saved for ${articleId}`);
            } else {
                this.logger.warn(`[Worker] UserArticle not found for ${articleId} (User: ${userId})`);
            }
        } catch (error) {
            this.logger.error(`[Worker] Audio job failed for ${articleId}:`, error);
            try {
                const userArticle = await this.userArticlesService.findByUserAndArticle(userId, articleId);
                if (userArticle) await this.userArticlesService.updateById(userArticle.id, { audioStatus: 'failed' });
            } catch (dbError) {
                this.logger.error('[Worker] Failed to update audio failure status:', dbError);
            }
            throw error;
        }
    }

    private async processChunkingJob(data: ChunkingJobData) {
        const { articleId } = data;
        this.logger.log(`[Worker] Processing chunking for article ${articleId}`);
        try {
            const article = await this.articlesService.findById(articleId);
            if (!article?.content) {
                this.logger.warn(`[Worker] Article ${articleId} not found or has no content`);
                return;
            }
            const existingChunksCount = await this.articleChunksService.countByArticleId(article.id);
            if (existingChunksCount > 0) {
                this.logger.log(`[Worker] Chunks already exist for article ${article.id}, skipping.`);
                return;
            }
            const chunks = this.genAiService.chunkText(article.content);
            this.logger.log(`[Worker] Chunking article ${article.id} into ${chunks.length} chunks`);
            for (let i = 0; i < chunks.length; i++) {
                let embedding: number[] = [];
                try {
                    embedding = await this.genAiService.generateEmbeddings(chunks[i], {
                        purpose: 'article_storage',
                        contextId: `${article.id}-chunk-${i}`,
                    });
                } catch (e) {
                    this.logger.error(`[Worker] Failed to generate embedding for chunk ${i} of article ${article.id}`, e);
                }
                await this.articleChunksService.create({
                    articleId: article.id,
                    chunkText: chunks[i],
                    chunkIndex: i,
                    chunkEmbedding: embedding.length > 0 ? embedding : undefined,
                });
            }
            this.logger.log(`[Worker] Successfully chunked article ${articleId}`);
        } catch (error) {
            this.logger.error(`[Worker] Chunking job failed for ${articleId}:`, error);
            throw error;
        }
    }

    async stop(): Promise<void> {
        const boss = this.jobQueueService.getBoss();
        await Promise.all([boss.offWork('summary-pro'), boss.offWork('audio-generation'), boss.offWork('article-chunking')]);
    }
}
