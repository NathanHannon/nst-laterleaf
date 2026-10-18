import { ForbiddenException } from '@nestjs/common';
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
import { ArticlesController } from './articles.controller';
import type { ArticlesService } from './articles.service';
import type { UserArticlesService } from './user-articles.service';

jest.mock('../jobs/job-queue.service', () => ({
    JobQueueService: class JobQueueService { },
}));

describe('ArticlesController provider authorization', () => {
    const nonAdmin: ClerkUserProfile = {
        id: 'user_123',
        clerkId: 'user_123',
        publicMetadata: { role: 'user' },
        rawToken: {},
    };

    it('returns saved podcast transcript data in the status payload', async () => {
        const userArticlesService = {
            findByUserAndArticle: jest.fn().mockResolvedValue({
                audioLocation: 'https://cdn.example.com/podcast.mp3',
                audioStatus: 'completed',
                podcastScript: {
                    script: 'Speaker 1: Welcome back.\nSpeaker 2: Let\'s dive in.',
                },
            }),
        } as unknown as UserArticlesService;
        const usersService = {
            findByClerkId: jest.fn().mockResolvedValue({
                id: 'database-user-id',
                isPro: true,
            }),
        } as unknown as UsersService;
        const controller = new ArticlesController(
            {} as ArticlesService,
            userArticlesService,
            {} as ArticleChunksService,
            usersService,
            {} as ContentExtractionService,
            {} as MetadataScrapingService,
            {} as ContentModerationService,
            {} as StorageService,
            {} as GenAiService,
            {} as JobQueueService,
            { get: jest.fn() } as unknown as ConfigService,
        );

        const result = await controller.getPodcastStatus(nonAdmin, 'article-id');

        expect(result.podcastScript).toEqual({
            script: 'Speaker 1: Welcome back.\nSpeaker 2: Let\'s dive in.',
        });
    });

    it('rejects a provider query submitted by a free non-admin before generation', async () => {
        const usersService = {
            findByClerkId: jest.fn().mockResolvedValue({
                id: 'database-user-id',
                isPro: false,
                basicCreditsUsed: 0,
                proCreditsUsed: 0,
                creditsResetAt: new Date(),
            }),
        } as unknown as UsersService;
        const genAiService = {
            generateSummary: jest.fn(),
        } as unknown as GenAiService;
        const configService = {
            get: jest.fn().mockReturnValue('admin_456'),
        } as unknown as ConfigService;
        const controller = new ArticlesController(
            {} as ArticlesService,
            {} as UserArticlesService,
            {} as ArticleChunksService,
            usersService,
            {} as ContentExtractionService,
            {} as MetadataScrapingService,
            {} as ContentModerationService,
            {} as StorageService,
            genAiService,
            {} as JobQueueService,
            {
                enforce: jest.fn().mockResolvedValue(undefined),
            } as any,
            configService,
        );

        await expect(controller.summarizeArticle(
            nonAdmin,
            'article-id',
            undefined,
            undefined,
            'en',
            'openai-compatible',
        )).rejects.toBeInstanceOf(ForbiddenException);
        expect(genAiService.generateSummary).not.toHaveBeenCalled();
    });

    it('allows a Pro non-admin to choose a provider for a summary', async () => {
        const user = {
            id: 'database-user-id',
            clerkId: 'user_123',
            isPro: true,
            basicCreditsUsed: 0,
            proCreditsUsed: 0,
            creditsResetAt: new Date(),
        };
        const usersService = {
            findByClerkId: jest.fn().mockResolvedValue(user),
            save: jest.fn().mockImplementation(async (savedUser) => savedUser),
        } as unknown as UsersService;
        const userArticlesService = {
            findByUserAndArticle: jest.fn().mockResolvedValue({
                id: 'user-article-id', articleId: 'article-id', summaryStatus: 'idle', summaryLanguage: 'en', hasContent: true,
            }),
            updateById: jest.fn().mockResolvedValue(undefined),
        } as unknown as UserArticlesService;
        const articlesService = {
            findById: jest.fn().mockResolvedValue({ id: 'article-id', content: 'Article content' }),
        } as unknown as ArticlesService;
        const jobQueueService = {
            addSummaryJob: jest.fn().mockResolvedValue(undefined),
        } as unknown as JobQueueService;
        const controller = new ArticlesController(
            articlesService, userArticlesService, {} as ArticleChunksService, usersService,
            {} as ContentExtractionService, {} as MetadataScrapingService, {} as ContentModerationService,
            {} as StorageService, {} as GenAiService, jobQueueService,
            { enforce: jest.fn().mockResolvedValue(undefined) } as any,
            { get: jest.fn().mockReturnValue('admin_456') } as unknown as ConfigService,
        );

        const result = await controller.summarizeArticle(nonAdmin, 'article-id', undefined, undefined, 'en', 'openai-compatible');

        expect(result).toMatchObject({ status: 'pending', model: 'gpt-5.4-mini' });
        expect(jobQueueService.addSummaryJob).toHaveBeenCalledWith(expect.objectContaining({ isPro: true, provider: 'openai-compatible' }));
    });

    it('returns a soft-cap warning when a free user is nearing their monthly summary limit', async () => {
        const user = {
            id: 'database-user-id',
            clerkId: 'user_123',
            isPro: false,
            basicCreditsUsed: 44,
            proCreditsUsed: 0,
            creditsResetAt: new Date(),
        };

        const userArticlesService = {
            findByUserAndArticle: jest.fn().mockResolvedValue({
                id: 'user-article-id',
                userId: user.id,
                articleId: 'article-id',
                summary: undefined,
                summaryStatus: undefined,
                summaryLanguage: 'en',
                hasContent: true,
            }),
            updateById: jest.fn().mockResolvedValue(undefined),
        } as unknown as UserArticlesService;

        const usersService = {
            findByClerkId: jest.fn().mockResolvedValue(user),
            save: jest.fn().mockImplementation(async (savedUser) => savedUser),
        } as unknown as UsersService;

        const configService = {
            get: jest.fn().mockImplementation((key: string) => {
                if (key === 'BASIC_CREDITS_LIMIT') return 50;
                if (key === 'PRO_CREDITS_LIMIT') return 5;
                return undefined;
            }),
        } as unknown as ConfigService;

        const controller = new ArticlesController(
            {
                findById: jest.fn().mockResolvedValue({
                    id: 'article-id',
                    content: 'This is a test article body for summarization.',
                }),
            } as unknown as ArticlesService,
            userArticlesService,
            {} as ArticleChunksService,
            usersService,
            {} as ContentExtractionService,
            {} as MetadataScrapingService,
            {} as ContentModerationService,
            {} as StorageService,
            {
                generateSummary: jest.fn().mockResolvedValue('Generated summary'),
            } as unknown as GenAiService,
            {
                addSummaryJob: jest.fn(),
            } as unknown as JobQueueService,
            {
                enforce: jest.fn().mockResolvedValue(undefined),
            } as unknown as any,
            configService,
        );

        const result = await controller.summarizeArticle(nonAdmin, 'article-id', 'true');

        expect(result.softCapWarning).toMatchObject({
            enabled: true,
            remaining: 5,
            limit: 50,
            threshold: 45,
        });
    });

    it('saves pasted text privately and returns escaped reader content', async () => {
        const savedAt = new Date();
        const userArticlesService = {
            create: jest.fn().mockImplementation(async (data) => ({
                id: 'user-article-id',
                ...data,
                createdAt: savedAt,
                updatedAt: savedAt,
            })),
        } as unknown as UserArticlesService;
        const usersService = {
            findByClerkId: jest.fn().mockResolvedValue({ id: 'database-user-id', isPro: false }),
        } as unknown as UsersService;
        const controller = new ArticlesController(
            {} as ArticlesService,
            userArticlesService,
            {} as ArticleChunksService,
            usersService,
            {} as ContentExtractionService,
            {} as MetadataScrapingService,
            {} as ContentModerationService,
            {} as StorageService,
            {} as GenAiService,
            {} as JobQueueService,
            { enforce: jest.fn().mockResolvedValue(undefined) } as any,
            { get: jest.fn() } as unknown as ConfigService,
        );

        const result = await controller.savePastedText(nonAdmin, { content: 'My copied title\n\n<script>alert(1)</script>' });

        expect(userArticlesService.create).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'database-user-id',
            pastedContent: 'My copied title\n\n<script>alert(1)</script>',
            hasContent: true,
        }));
        expect(result).toMatchObject({
            id: 'pasted-user-article-id',
            title: 'My copied title',
            isPastedText: true,
            contentHtml: '<p>My copied title</p><p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
        });
    });

    it('deletes an orphaned podcast file when a re-saved article has no audio URL', async () => {
        const audioUrl = 'https://cdn.example.com/podcasts/database-user-id/article-id_podcast-old.mp3';
        const userArticlesService = {
            findByUserAndArticle: jest.fn().mockResolvedValue({ id: 'user-article-id' }),
            updateById: jest.fn().mockResolvedValue(undefined),
        } as unknown as UserArticlesService;
        const usersService = {
            findByClerkId: jest.fn().mockResolvedValue({ id: 'database-user-id', isPro: true }),
        } as unknown as UsersService;
        const storageService = {
            checkAudioExists: jest.fn().mockResolvedValue(audioUrl),
            deletePodcastAudio: jest.fn().mockResolvedValue(undefined),
        } as unknown as StorageService;
        const controller = new ArticlesController(
            {} as ArticlesService,
            userArticlesService,
            {} as ArticleChunksService,
            usersService,
            {} as ContentExtractionService,
            {} as MetadataScrapingService,
            {} as ContentModerationService,
            storageService,
            {} as GenAiService,
            {} as JobQueueService,
            { enforce: jest.fn().mockResolvedValue(undefined) } as any,
            { get: jest.fn() } as unknown as ConfigService,
        );

        await controller.deletePodcastAudio(nonAdmin, 'article-id');

        expect(storageService.checkAudioExists).toHaveBeenCalledWith('article-id', 'database-user-id', 'podcast');
        expect(storageService.deletePodcastAudio).toHaveBeenCalledWith(audioUrl);
        expect(userArticlesService.updateById).toHaveBeenCalledWith('user-article-id', {
            audioLocation: null,
            podcastScript: null,
            audioStatus: 'idle',
        });
    });

    it('clears a persisted podcast URL instead of leaving it linked after deletion', async () => {
        const audioUrl = 'https://cdn.example.com/podcast.mp3';
        const userArticlesService = {
            findByUserAndArticle: jest.fn().mockResolvedValue({ id: 'user-article-id', audioLocation: audioUrl }),
            updateById: jest.fn().mockResolvedValue(undefined),
        } as unknown as UserArticlesService;
        const usersService = {
            findByClerkId: jest.fn().mockResolvedValue({ id: 'database-user-id', isPro: true }),
        } as unknown as UsersService;
        const storageService = {
            deletePodcastAudio: jest.fn().mockResolvedValue(undefined),
        } as unknown as StorageService;
        const controller = new ArticlesController(
            {} as ArticlesService,
            userArticlesService,
            {} as ArticleChunksService,
            usersService,
            {} as ContentExtractionService,
            {} as MetadataScrapingService,
            {} as ContentModerationService,
            storageService,
            {} as GenAiService,
            {} as JobQueueService,
            { enforce: jest.fn().mockResolvedValue(undefined) } as any,
            { get: jest.fn() } as unknown as ConfigService,
        );

        await controller.deletePodcastAudio(nonAdmin, 'article-id');

        expect(storageService.deletePodcastAudio).toHaveBeenCalledWith(audioUrl);
        expect(userArticlesService.updateById).toHaveBeenCalledWith('user-article-id', {
            audioLocation: null,
            podcastScript: null,
            audioStatus: 'idle',
        });
    });

    it('deletes orphaned podcast audio before removing a saved article', async () => {
        const audioUrl = 'https://cdn.example.com/podcasts/database-user-id/article-id_podcast-old.mp3';
        const userArticle = { id: 'user-article-id', articleId: 'article-id', isBookmarked: false };
        const deleteUserArticle = jest.fn().mockResolvedValue(undefined);
        const userArticlesService = {
            findByUserAndArticle: jest.fn().mockResolvedValue(userArticle),
            delete: deleteUserArticle,
        } as unknown as UserArticlesService;
        const usersService = {
            findByClerkId: jest.fn().mockResolvedValue({ id: 'database-user-id', isPro: false }),
        } as unknown as UsersService;
        const storageService = {
            checkAudioExists: jest.fn().mockResolvedValue(audioUrl),
            deletePodcastAudio: jest.fn().mockResolvedValue(undefined),
        } as unknown as StorageService;
        const controller = new ArticlesController(
            { updateSaveCountAtomic: jest.fn().mockResolvedValue(undefined) } as unknown as ArticlesService,
            userArticlesService,
            {} as ArticleChunksService,
            usersService,
            {} as ContentExtractionService,
            {} as MetadataScrapingService,
            {} as ContentModerationService,
            storageService,
            {} as GenAiService,
            {} as JobQueueService,
            { enforce: jest.fn().mockResolvedValue(undefined) } as any,
            { get: jest.fn() } as unknown as ConfigService,
        );

        await controller.deleteById(nonAdmin, 'article-id');

        expect(storageService.checkAudioExists).toHaveBeenCalledWith('article-id', 'database-user-id', 'podcast');
        expect(storageService.deletePodcastAudio).toHaveBeenCalledWith(audioUrl);
        expect(deleteUserArticle).toHaveBeenCalledWith(userArticle);
        expect(storageService.deletePodcastAudio.mock.invocationCallOrder[0])
            .toBeLessThan(deleteUserArticle.mock.invocationCallOrder[0]);
    });
});
