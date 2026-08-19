jest.mock('pg-boss', () => ({
    PgBoss: jest.fn().mockImplementation(() => ({
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
        publish: jest.fn(),
        subscribe: jest.fn(),
    })),
}));

import { HttpException, HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import type { ContentExtractionService } from '../content-extraction/content-extraction.service';
import type { MetadataScrapingService } from '../content-extraction/metadata-scraping.service';
import type { ContentModerationService } from '../content-moderation/content-moderation.service';
import type { GenAiService } from '../genai/gen-ai.service';
import type { JobQueueService } from '../jobs/job-queue.service';
import type { StorageService } from '../storage/storage.service';
import type { UsersService } from '../users/users.service';
import type { ArticleChunksService } from './article-chunks.service';
import type { DataSource } from 'typeorm';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { ArticlesController } from './articles.controller';
import { ArticleTranslationController } from './article-translation.controller';
import { ChatController } from './chat.controller';
import type { ArticlesService } from './articles.service';
import type { UserArticlesService } from './user-articles.service';
import { fail } from 'assert';

/**
 * Rate-limit tests for LLM-backed endpoints.
 * All GenAiService / RateLimitService calls are mocked — no real LLM or DB, no bill.
 * Verifies burst limits are enforced BEFORE any LLM call and that cached hits bypass the limiter.
 * Rate limiting now uses RateLimitService (public.rate_limits via DataSource), not pg-boss.
 */
describe('LLM burst rate limits (no bill)', () => {
    /**
     * Real RateLimitService so multi-window enforcement/refund logic is covered,
     * with only the DB-touching checkRateLimit stubbed.
     */
    function makeRateLimitService(overrides: Partial<RateLimitService> = {}): RateLimitService {
        const service = new RateLimitService({ query: jest.fn().mockResolvedValue([]) } as unknown as DataSource);
        service.checkRateLimit = jest.fn().mockResolvedValue({ allowed: true, remaining: 4, resetIn: 60 });
        Object.assign(service, overrides);
        return service;
    }

    const clerkUser: ClerkUserProfile = {
        id: 'clerk_123',
        clerkId: 'clerk_123',
        publicMetadata: { role: 'user' },
        rawToken: {},
    };
    const proClerkUser: ClerkUserProfile = {
        id: 'clerk_pro',
        clerkId: 'clerk_pro',
        publicMetadata: { role: 'user' },
        rawToken: {},
    };
    const dbUser = {
        id: 'db-user-id',
        clerkId: 'clerk_123',
        isPro: false,
        basicCreditsUsed: 0,
        proCreditsUsed: 0,
        creditsResetAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        subscriptionStatus: 'inactive' as const,
    } as any;
    const proDbUser = { ...dbUser, id: 'db-pro-id', clerkId: 'clerk_pro', isPro: true };

    const article = {
        id: 'article-id',
        url: 'https://example.com/a',
        title: 'Test',
        content: 'Hello world content '.repeat(200),
        contentHtml: '<p>Hello</p>',
    } as any;

    const userArticleLink = {
        id: 'ua-id',
        userId: dbUser.id,
        articleId: article.id,
        summary: undefined,
        summaryStatus: undefined,
        summaryLanguage: 'en',
        hasContent: true,
    } as any;

    function makeArticlesController(overrides: {
        rateLimit?: Partial<RateLimitService>;
        jobQueue?: Partial<JobQueueService>;
        genAi?: Partial<GenAiService>;
        users?: Partial<UsersService>;
        userArticles?: Partial<UserArticlesService>;
        articles?: Partial<ArticlesService>;
        storage?: Partial<StorageService>;
        config?: Partial<ConfigService>;
    } = {}) {
        const rateLimitService = makeRateLimitService(overrides.rateLimit);
        const jobQueue = {
            addSummaryJob: jest.fn(),
            addChunkingJob: jest.fn().mockResolvedValue(undefined),
            addAudioJob: jest.fn().mockResolvedValue(undefined),
            ...overrides.jobQueue,
        } as unknown as JobQueueService;
        const genAi = {
            generateSummary: jest.fn().mockResolvedValue('summary text'),
            generateEmbeddings: jest.fn().mockResolvedValue([0.1, 0.2]),
            ...overrides.genAi,
        } as unknown as GenAiService;
        const usersService = {
            findByClerkId: jest.fn().mockImplementation(async (clerkId: string) => {
                if (clerkId === proClerkUser.clerkId) return proDbUser;
                return dbUser;
            }),
            save: jest.fn().mockImplementation(async (u: any) => u),
            ...overrides.users,
        } as unknown as UsersService;
        const userArticlesService = {
            findByUserAndArticle: jest.fn().mockResolvedValue({ ...userArticleLink }),
            findById: jest.fn(),
            findByUserAndOriginalUrl: jest.fn().mockResolvedValue(null),
            updateById: jest.fn().mockResolvedValue(undefined),
            save: jest.fn(),
            create: jest.fn(),
            findUrlOnlyEntries: jest.fn().mockResolvedValue([]),
            ...overrides.userArticles,
        } as unknown as UserArticlesService;
        const articlesService = {
            findById: jest.fn().mockResolvedValue({ ...article }),
            findByUrl: jest.fn().mockResolvedValue(null),
            findDuplicateByEmbedding: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ ...article }),
            saveEmbedding: jest.fn().mockResolvedValue(undefined),
            updateSaveCountAtomic: jest.fn(),
            updateBookmarkCountAtomic: jest.fn(),
            count: jest.fn(),
            findByIds: jest.fn(),
            updateById: jest.fn(),
            ...overrides.articles,
        } as unknown as ArticlesService;
        const configService = {
            get: jest.fn().mockReturnValue(undefined),
            ...overrides.config,
        } as unknown as ConfigService;
        const storageService = {
            checkAudioExists: jest.fn().mockResolvedValue(null),
            uploadAudio: jest.fn().mockResolvedValue('https://cdn.test/audio.mp3'),
            ...overrides.storage,
        } as unknown as StorageService;

        const controller = new ArticlesController(
            articlesService,
            userArticlesService,
            {} as ArticleChunksService,
            usersService,
            {
                extractContent: jest.fn().mockResolvedValue({
                    content: 'extracted',
                    contentHtml: '<p>extracted</p>',
                    title: 'T',
                    excerpt: 'E',
                    imageUrl: null,
                    extractionMethod: 'static',
                    processingTimeMs: 10,
                }),
            } as unknown as ContentExtractionService,
            {
                scrapeMetadata: jest.fn().mockResolvedValue({}),
            } as unknown as MetadataScrapingService,
            {
                moderateForSaving: jest.fn().mockResolvedValue({ shouldBlockSave: false, flaggedCategories: [] }),
                moderateForRecommendations: jest.fn().mockResolvedValue({ isEligibleForRecommendation: true }),
            } as unknown as ContentModerationService,
            storageService,
            genAi,
            jobQueue,
            rateLimitService,
            configService,
        );
        return { controller, rateLimitService, jobQueue, genAi, usersService, userArticlesService, articlesService, storageService, configService };
    }

    describe('POST :id/summarize — basic (free) summaries', () => {
        it('allows within 5/min, 30/hr, 100/day and calls LLM', async () => {
            const { controller, rateLimitService, genAi } = makeArticlesController();
            const result = await controller.summarizeArticle(clerkUser, article.id, 'true', undefined, 'en');
            expect(result.status).toBe('completed');
            expect(rateLimitService.checkRateLimit).toHaveBeenCalledTimes(3);
            expect(rateLimitService.checkRateLimit).toHaveBeenNthCalledWith(1, dbUser.id, 'summary-basic:60s', 5, 60);
            expect(rateLimitService.checkRateLimit).toHaveBeenNthCalledWith(2, dbUser.id, 'summary-basic:3600s', 30, 3600);
            expect(rateLimitService.checkRateLimit).toHaveBeenNthCalledWith(3, dbUser.id, 'summary-basic:86400s', 100, 86400);
            expect(genAi.generateSummary).toHaveBeenCalled();
        });

        it('blocks 6th per minute with 429 and does NOT call LLM', async () => {
            const checkRateLimit = jest.fn().mockResolvedValue({ allowed: false, remaining: 0, resetIn: 42 });
            const genAi = { generateSummary: jest.fn(), generateEmbeddings: jest.fn().mockResolvedValue([0.1]) } as unknown as GenAiService;
            const { controller } = makeArticlesController({ rateLimit: { checkRateLimit } as any, genAi });
            try {
                await controller.summarizeArticle(clerkUser, article.id, 'true');
                fail('should have thrown 429');
            } catch (e) {
                expect((e as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
                expect((e as HttpException).message).toMatch(/5 per minute/);
                expect((e as HttpException).message).toMatch(/42s/);
            }
            expect(genAi.generateSummary).not.toHaveBeenCalled();
            expect(checkRateLimit).toHaveBeenCalledWith(dbUser.id, 'summary-basic:60s', 5, 60);
        });

        it('blocks when hourly 30/hr exceeded', async () => {
            const checkRateLimit = jest
                .fn()
                .mockResolvedValueOnce({ allowed: true, remaining: 4, resetIn: 10 })
                .mockResolvedValueOnce({ allowed: false, remaining: 0, resetIn: 120 });
            const { controller, genAi } = makeArticlesController({ rateLimit: { checkRateLimit } as any });
            await expect(controller.summarizeArticle(clerkUser, article.id, 'true')).rejects.toMatchObject({
                status: HttpStatus.TOO_MANY_REQUESTS,
            });
            expect((genAi as any).generateSummary).not.toHaveBeenCalled();
        });

        it('blocks when daily 100/day exceeded', async () => {
            const checkRateLimit = jest
                .fn()
                .mockResolvedValueOnce({ allowed: true, remaining: 4, resetIn: 10 })
                .mockResolvedValueOnce({ allowed: true, remaining: 10, resetIn: 100 })
                .mockResolvedValueOnce({ allowed: false, remaining: 0, resetIn: 3600 });
            const { controller } = makeArticlesController({ rateLimit: { checkRateLimit } as any });
            await expect(controller.summarizeArticle(clerkUser, article.id, 'true')).rejects.toThrow(HttpException);
        });

        it('cached hit (no force, same language) bypasses rate limiter and LLM', async () => {
            const checkRateLimit = jest.fn();
            const genAi = { generateSummary: jest.fn() } as unknown as GenAiService;
            const { controller } = makeArticlesController({
                rateLimit: { checkRateLimit } as any,
                genAi,
                userArticles: {
                    findByUserAndArticle: jest.fn().mockResolvedValue({
                        ...userArticleLink,
                        summary: 'cached summary',
                        summaryStatus: 'completed',
                        summaryLanguage: 'en',
                    }),
                } as any,
            });
            const result = await controller.summarizeArticle(clerkUser, article.id, undefined, undefined, 'en');
            expect(result.summary).toBe('cached summary');
            expect(checkRateLimit).not.toHaveBeenCalled();
            expect(genAi.generateSummary).not.toHaveBeenCalled();
        });

        it('force=true bypasses cache and IS rate limited', async () => {
            const checkRateLimit = jest.fn().mockResolvedValue({ allowed: false, remaining: 0, resetIn: 10 });
            const { controller } = makeArticlesController({
                rateLimit: { checkRateLimit } as any,
                userArticles: {
                    findByUserAndArticle: jest.fn().mockResolvedValue({
                        ...userArticleLink,
                        summary: 'cached',
                        summaryStatus: 'completed',
                        summaryLanguage: 'en',
                    }),
                } as any,
            });
            await expect(controller.summarizeArticle(clerkUser, article.id, 'true')).rejects.toMatchObject({
                status: HttpStatus.TOO_MANY_REQUESTS,
            });
        });

        it('fail-open when rate limiter table not ready (throws non-HttpException)', async () => {
            const checkRateLimit = jest.fn().mockRejectedValue(new Error('relation "rate_limits" does not exist'));
            const { controller, genAi } = makeArticlesController({ rateLimit: { checkRateLimit } as any });
            const result = await controller.summarizeArticle(clerkUser, article.id, 'true');
            expect(result.status).toBe('completed');
            expect(genAi.generateSummary).toHaveBeenCalled();
        });
    });

    describe('POST :id/summarize — pro summaries', () => {
        it('uses pro limits 10/min, 60/hr, 200/day for pro users', async () => {
            const checkRateLimit = jest.fn().mockResolvedValue({ allowed: true, remaining: 9, resetIn: 60 });
            const { controller } = makeArticlesController({
                rateLimit: { checkRateLimit } as any,
                jobQueue: { addSummaryJob: jest.fn().mockResolvedValue(undefined) } as any,
                users: {
                    findByClerkId: jest.fn().mockResolvedValue(proDbUser),
                    save: jest.fn().mockImplementation(async (u: any) => u),
                } as any,
            });
            const result = await controller.summarizeArticle(proClerkUser, article.id, 'true');
            expect(result.status).toBe('pending');
            expect(checkRateLimit).toHaveBeenCalledWith(proDbUser.id, 'summary-pro:60s', 10, 60);
            expect(checkRateLimit).toHaveBeenCalledWith(proDbUser.id, 'summary-pro:3600s', 60, 3600);
            expect(checkRateLimit).toHaveBeenCalledWith(proDbUser.id, 'summary-pro:86400s', 200, 86400);
        });
    });

    describe('POST /articles/import and POST /articles/from-extension — embeddings only', () => {
        it('import enforces 20/min, 100/hr, 500/day before extraction', async () => {
            const checkRateLimit = jest.fn().mockResolvedValue({ allowed: false, remaining: 0, resetIn: 30 });
            const extractContent = jest.fn();
            const { controller } = makeArticlesController({
                rateLimit: { checkRateLimit } as any,
            });
            (controller as any).contentExtractionService.extractContent = extractContent;
            await expect(controller.import(clerkUser, { url: 'https://example.com/new' })).rejects.toMatchObject({
                status: HttpStatus.TOO_MANY_REQUESTS,
            });
            expect(extractContent).not.toHaveBeenCalled();
            expect(checkRateLimit).toHaveBeenCalledWith(dbUser.id, 'import:60s', 20, 60);
        });

        it('import allows within limits', async () => {
            const checkRateLimit = jest.fn().mockResolvedValue({ allowed: true, remaining: 19, resetIn: 60 });
            const { controller } = makeArticlesController({ rateLimit: { checkRateLimit } as any });
            const result = await controller.import(clerkUser, { url: 'https://example.com/new2' });
            expect(result.success).toBe(true);
            expect(checkRateLimit).toHaveBeenCalledTimes(3);
        });

        it('from-extension enforces same import limits', async () => {
            const checkRateLimit = jest.fn().mockResolvedValue({ allowed: false, remaining: 0, resetIn: 15 });
            const { controller } = makeArticlesController({ rateLimit: { checkRateLimit } as any });
            await expect(
                controller.createFromExtension(clerkUser, {
                    url: 'https://example.com/ext',
                    title: 'T',
                    content: 'C',
                    contentHtml: '<p>C</p>',
                }),
            ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
        });
    });

    describe('POST :id/translate — 5/min, 20/hr', () => {
        function makeTranslationController(overrides: any = {}) {
            const rateLimitService = makeRateLimitService(overrides.rateLimitService);
            const genAi = {
                translateArticle: jest.fn().mockResolvedValue('translated'),
                ...overrides.genAi,
            } as unknown as GenAiService;
            const usersService = {
                findByClerkId: jest.fn().mockResolvedValue(dbUser),
                ...overrides.usersService,
            } as unknown as UsersService;
            const articlesService = {
                findById: jest.fn().mockResolvedValue({ ...article, translations: {} }),
                updateById: jest.fn().mockResolvedValue(undefined),
                ...overrides.articlesService,
            } as unknown as ArticlesService;
            const controller = new ArticleTranslationController(articlesService, genAi, usersService, rateLimitService);
            return { controller, rateLimitService, genAi, usersService, articlesService };
        }

        it('allows within limits and calls LLM', async () => {
            const { controller, rateLimitService, genAi } = makeTranslationController();
            const result = await controller.translateArticle(article.id, { targetLanguage: 'es' }, clerkUser);
            expect(result.cached).toBe(false);
            expect(rateLimitService.checkRateLimit).toHaveBeenCalledWith(dbUser.id, 'translate:60s', 5, 60);
            expect(rateLimitService.checkRateLimit).toHaveBeenCalledWith(dbUser.id, 'translate:3600s', 20, 3600);
            expect(genAi.translateArticle).toHaveBeenCalled();
        });

        it('blocks 6th per minute with 429 and does NOT call LLM', async () => {
            const checkRateLimit = jest.fn().mockResolvedValueOnce({ allowed: false, remaining: 0, resetIn: 25 });
            const genAi = { translateArticle: jest.fn() } as unknown as GenAiService;
            const { controller } = makeTranslationController({ rateLimitService: { checkRateLimit } as any, genAi });
            await expect(controller.translateArticle(article.id, { targetLanguage: 'es' }, clerkUser)).rejects.toMatchObject({
                status: HttpStatus.TOO_MANY_REQUESTS,
            });
            expect(genAi.translateArticle).not.toHaveBeenCalled();
        });

        it('cached translation still counts toward rate limit (checked before cache)', async () => {
            const checkRateLimit = jest.fn().mockResolvedValue({ allowed: false, remaining: 0, resetIn: 10 });
            const { controller } = makeTranslationController({
                rateLimitService: { checkRateLimit } as any,
                articlesService: {
                    findById: jest.fn().mockResolvedValue({ ...article, translations: { es: 'cached' } }),
                } as any,
            });
            await expect(controller.translateArticle(article.id, { targetLanguage: 'es' }, clerkUser)).rejects.toMatchObject({
                status: HttpStatus.TOO_MANY_REQUESTS,
            });
        });
    });

    describe('POST :id/chat — 10/min, 50/hr (Pro only)', () => {
        function makeChatController(overrides: any = {}) {
            const rateLimitService = makeRateLimitService(
                overrides.rateLimitService ?? {
                    checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 9, resetIn: 60 }),
                },
            );
            const genAi = {
                generateEmbeddings: jest.fn().mockResolvedValue([0.1]),
                generateChatMessage: jest.fn().mockResolvedValue({ response: 'hi', interactionId: 'int-1' }),
                ...overrides.genAi,
            } as unknown as GenAiService;
            const usersService = {
                findByClerkId: jest.fn().mockResolvedValue(proDbUser),
                ...overrides.usersService,
            } as unknown as UsersService;
            const userArticlesService = {
                findByUserAndArticle: jest.fn().mockResolvedValue({
                    ...userArticleLink,
                    userId: proDbUser.id,
                    articleId: article.id,
                    chatHistory: [],
                }),
                updateById: jest.fn().mockResolvedValue(undefined),
                ...overrides.userArticlesService,
            } as unknown as UserArticlesService;
            const articlesService = {
                findById: jest.fn().mockResolvedValue({ ...article }),
                ...overrides.articlesService,
            } as unknown as ArticlesService;
            const articleChunksService = {
                findRelevantChunks: jest.fn().mockResolvedValue([]),
                ...overrides.articleChunksService,
            } as unknown as ArticleChunksService;
            const controller = new ChatController(usersService, userArticlesService, articlesService, articleChunksService, genAi, rateLimitService);
            return { controller, rateLimitService, genAi, usersService };
        }

        it('allows within limits for Pro user', async () => {
            const { controller, rateLimitService } = makeChatController();
            const result = await controller.chatWithArticle(article.id, { message: 'hello' }, proClerkUser);
            expect(result.response).toBe('hi');
            expect(rateLimitService.checkRateLimit).toHaveBeenCalledWith(proDbUser.id, 'chat:60s', 10, 60);
            expect(rateLimitService.checkRateLimit).toHaveBeenCalledWith(proDbUser.id, 'chat:3600s', 50, 3600);
        });

        it('blocks 11th per minute with 429 and does NOT call LLM', async () => {
            const checkRateLimit = jest.fn().mockResolvedValueOnce({ allowed: false, remaining: 0, resetIn: 20 });
            const genAi = {
                generateEmbeddings: jest.fn(),
                generateChatMessage: jest.fn(),
            } as unknown as GenAiService;
            const { controller } = makeChatController({ rateLimitService: { checkRateLimit } as any, genAi });
            await expect(controller.chatWithArticle(article.id, { message: 'hello' }, proClerkUser)).rejects.toMatchObject({
                status: HttpStatus.TOO_MANY_REQUESTS,
            });
            expect(genAi.generateEmbeddings).not.toHaveBeenCalled();
            expect(genAi.generateChatMessage).not.toHaveBeenCalled();
        });

        it('non-Pro is rejected before rate limit (403)', async () => {
            const checkRateLimit = jest.fn();
            const { controller } = makeChatController({
                usersService: { findByClerkId: jest.fn().mockResolvedValue(dbUser) } as any,
                rateLimitService: { checkRateLimit } as any,
            });
            await expect(controller.chatWithArticle(article.id, { message: 'hello' }, clerkUser)).rejects.toMatchObject({
                status: HttpStatus.FORBIDDEN,
            });
            expect(checkRateLimit).not.toHaveBeenCalled();
        });
    });

    describe('audio endpoints — TTS is billed per character', () => {
        const res = () => ({
            redirect: jest.fn(),
            setHeader: jest.fn(),
            status: jest.fn().mockReturnThis(),
            send: jest.fn(),
        }) as any;

        it('GET :id/audio enforces 5/min, 30/hr, 100/day before synthesis', async () => {
            const checkRateLimit = jest.fn().mockResolvedValue({ allowed: false, remaining: 0, resetIn: 12 });
            const genAi = { generateSpeech: jest.fn() } as unknown as GenAiService;
            const { controller } = makeArticlesController({ rateLimit: { checkRateLimit } as any, genAi });
            await expect(controller.generateArticleAudio(clerkUser, article.id, res())).rejects.toMatchObject({
                status: HttpStatus.TOO_MANY_REQUESTS,
            });
            expect(checkRateLimit).toHaveBeenCalledWith(dbUser.id, 'audio:60s', 5, 60);
            expect((genAi as any).generateSpeech).not.toHaveBeenCalled();
        });

        it('GET :id/audio fails CLOSED when the limiter errors', async () => {
            const checkRateLimit = jest.fn().mockRejectedValue(new Error('db down'));
            const genAi = { generateSpeech: jest.fn() } as unknown as GenAiService;
            const { controller } = makeArticlesController({ rateLimit: { checkRateLimit } as any, genAi });
            await expect(controller.generateArticleAudio(clerkUser, article.id, res())).rejects.toMatchObject({
                status: HttpStatus.SERVICE_UNAVAILABLE,
            });
            expect((genAi as any).generateSpeech).not.toHaveBeenCalled();
        });

        it('GET :id/audio skips the limiter on a cached hit', async () => {
            const checkRateLimit = jest.fn();
            const { controller } = makeArticlesController({
                rateLimit: { checkRateLimit } as any,
                articles: {
                    findById: jest.fn().mockResolvedValue({
                        ...article,
                        narrationLocation: 'https://cdn.test/cached.mp3',
                        narrationStatus: 'completed',
                    }),
                } as any,
            });
            const response = res();
            await controller.generateArticleAudio(clerkUser, article.id, response);
            expect(response.redirect).toHaveBeenCalledWith('https://cdn.test/cached.mp3');
            expect(checkRateLimit).not.toHaveBeenCalled();
        });

        it('GET :id/summary/audio is rate limited (it has no cache at all)', async () => {
            const checkRateLimit = jest.fn().mockResolvedValue({ allowed: false, remaining: 0, resetIn: 8 });
            const genAi = { generateSummaryAudio: jest.fn() } as unknown as GenAiService;
            const { controller } = makeArticlesController({
                rateLimit: { checkRateLimit } as any,
                genAi,
                userArticles: {
                    findByUserAndArticle: jest.fn().mockResolvedValue({ ...userArticleLink, summary: 'a summary' }),
                } as any,
            });
            await expect(controller.generateSummaryAudio(clerkUser, article.id, res())).rejects.toMatchObject({
                status: HttpStatus.TOO_MANY_REQUESTS,
            });
            expect((genAi as any).generateSummaryAudio).not.toHaveBeenCalled();
        });

        it('GET :id/podcast-audio with force=true is rate limited and does not enqueue', async () => {
            const checkRateLimit = jest.fn().mockResolvedValue({ allowed: false, remaining: 0, resetIn: 40 });
            const addAudioJob = jest.fn();
            const { controller } = makeArticlesController({
                rateLimit: { checkRateLimit } as any,
                jobQueue: { addAudioJob } as any,
                users: { findByClerkId: jest.fn().mockResolvedValue(proDbUser) } as any,
                userArticles: {
                    findByUserAndArticle: jest.fn().mockResolvedValue({
                        ...userArticleLink,
                        audioLocation: 'https://cdn.test/old.mp3',
                    }),
                    updateById: jest.fn().mockResolvedValue(undefined),
                } as any,
            });
            await expect(
                controller.generatePodcastAudio(
                    proClerkUser,
                    article.id,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    'true',
                ),
            ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
            expect(checkRateLimit).toHaveBeenCalledWith(proDbUser.id, 'podcast:60s', 3, 60);
            expect(addAudioJob).not.toHaveBeenCalled();
        });

        it('GET :id/podcast-audio does not re-enqueue while a job is pending', async () => {
            const checkRateLimit = jest.fn();
            const addAudioJob = jest.fn();
            const { controller } = makeArticlesController({
                rateLimit: { checkRateLimit } as any,
                jobQueue: { addAudioJob } as any,
                users: { findByClerkId: jest.fn().mockResolvedValue(proDbUser) } as any,
                userArticles: {
                    findByUserAndArticle: jest.fn().mockResolvedValue({
                        ...userArticleLink,
                        audioLocation: undefined,
                        audioStatus: 'pending',
                    }),
                } as any,
            });
            const result = await controller.generatePodcastAudio(proClerkUser, article.id);
            expect(result.audioUrl).toBe('processing');
            expect(addAudioJob).not.toHaveBeenCalled();
            expect(checkRateLimit).not.toHaveBeenCalled();
        });
    });

    describe('RateLimitService.enforce', () => {
        it('refunds earlier windows when a later window rejects', async () => {
            const query = jest.fn().mockResolvedValue([]);
            const service = new RateLimitService({ query } as unknown as DataSource);
            service.checkRateLimit = jest
                .fn()
                .mockResolvedValueOnce({ allowed: true, remaining: 4, resetIn: 30 })
                .mockResolvedValueOnce({ allowed: false, remaining: 0, resetIn: 900 });

            await expect(
                service.enforce('user-1', 'summary-basic', [
                    { limit: 5, windowSeconds: 60, label: '5 per minute' },
                    { limit: 30, windowSeconds: 3600, label: '30 per hour' },
                ]),
            ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS, retryAfterSeconds: 900 });

            expect(query).toHaveBeenCalledWith(expect.stringContaining('GREATEST(count - 1, 0)'), [
                ['ratelimit:summary-basic:60s:user-1'],
            ]);
        });

        it('does not refund when every window allows the request', async () => {
            const query = jest.fn().mockResolvedValue([]);
            const service = new RateLimitService({ query } as unknown as DataSource);
            service.checkRateLimit = jest.fn().mockResolvedValue({ allowed: true, remaining: 1, resetIn: 5 });

            await service.enforce('user-1', 'chat', [
                { limit: 10, windowSeconds: 60, label: '10 per minute' },
                { limit: 50, windowSeconds: 3600, label: '50 per hour' },
            ]);

            expect(query).not.toHaveBeenCalled();
        });
    });
});
