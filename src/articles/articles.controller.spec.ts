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

    it('rejects a provider query submitted by a non-admin before generation', async () => {
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
});