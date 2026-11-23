import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { ResearchController } from './research.controller';

describe('ResearchController pasted sources', () => {
    it('includes user-scoped pasted search results in research sources', async () => {
        const usersService = {
            findByClerkId: jest.fn().mockResolvedValue({ id: 'user-a', isPro: true }),
        };
        const articlesService = {
            semanticSearch: jest.fn().mockResolvedValue([]),
        };
        const articleChunksService = {
            findRelevantChunks: jest.fn().mockResolvedValue([]),
        };
        const userArticlesService = {
            semanticSearchPasted: jest.fn().mockResolvedValue([{
                userArticleId: 'entry-a',
                title: 'My notes',
                content: 'Private notes about the topic.',
                excerpt: 'Private notes about the topic.',
                distance: 0.2,
            }]),
        };
        const genAiService = {
            generateEmbeddings: jest.fn().mockResolvedValue([0.1, 0.2]),
            generateResearchReport: jest.fn().mockResolvedValue('Research report'),
        };
        const controller = new ResearchController(
            usersService as never,
            articlesService as never,
            articleChunksService as never,
            userArticlesService as never,
            genAiService as never,
        );

        const result = await controller.researchArticles(
            { query: 'the topic' },
            { clerkId: 'clerk-a' } as ClerkUserProfile,
        );

        expect(userArticlesService.semanticSearchPasted).toHaveBeenCalledWith([0.1, 0.2], 'user-a', 15);
        expect(genAiService.generateResearchReport).toHaveBeenCalledWith(
            'the topic',
            [expect.objectContaining({
                id: 'pasted-entry-a',
                title: 'My notes',
                content: 'Private notes about the topic.',
            })],
            undefined,
        );
        expect(result.sources).toEqual([{ id: 'pasted-entry-a', title: 'My notes', url: '' }]);
    });

    it('caches reports per user when query and matching sources are unchanged, and invalidates on source change or force', async () => {
        const usersService = {
            findByClerkId: jest.fn(async (clerkId: string) => ({
                id: clerkId === 'clerk-a' ? 'user-a' : 'user-b',
                isPro: true,
            })),
        };
        const articlesService = {
            semanticSearch: jest.fn().mockResolvedValue([
                { id: 'art-1', title: 'Article 1', url: 'https://example.com/1', content: 'Body 1', distance: 0.1 },
            ]),
        };
        const articleChunksService = {
            findRelevantChunks: jest.fn().mockResolvedValue([]),
        };
        const userArticlesService = {
            semanticSearchPasted: jest.fn().mockResolvedValue([]),
        };
        const genAiService = {
            generateEmbeddings: jest.fn().mockResolvedValue([0.1, 0.2]),
            generateResearchReport: jest.fn()
                .mockResolvedValueOnce('Report v1')
                .mockResolvedValueOnce('Report for user B')
                .mockResolvedValueOnce('Report with new article')
                .mockResolvedValueOnce('Forced fresh report'),
        };
        const controller = new ResearchController(
            usersService as never,
            articlesService as never,
            articleChunksService as never,
            userArticlesService as never,
            genAiService as never,
        );

        // 1. First call populates cache
        const first = await controller.researchArticles({ query: '  AI   Safety ' }, { clerkId: 'clerk-a' } as ClerkUserProfile);
        expect(first.report).toBe('Report v1');
        expect(genAiService.generateResearchReport).toHaveBeenCalledTimes(1);

        // 2. Normalized repeat call for same user hits cache
        const second = await controller.researchArticles({ query: 'ai safety' }, { clerkId: 'clerk-a' } as ClerkUserProfile);
        expect(second.report).toBe('Report v1');
        expect(genAiService.generateResearchReport).toHaveBeenCalledTimes(1);

        // 3. Different user with same query + same article ID does NOT share cache
        const otherUser = await controller.researchArticles({ query: 'ai safety' }, { clerkId: 'clerk-b' } as ClerkUserProfile);
        expect(otherUser.report).toBe('Report for user B');
        expect(genAiService.generateResearchReport).toHaveBeenCalledTimes(2);

        // 4. Adding a new matching article invalidates user A's cache automatically
        articlesService.semanticSearch.mockResolvedValueOnce([
            { id: 'art-1', title: 'Article 1', url: 'https://example.com/1', content: 'Body 1', distance: 0.1 },
            { id: 'art-2', title: 'Article 2', url: 'https://example.com/2', content: 'Body 2', distance: 0.2 },
        ]);
        const updated = await controller.researchArticles({ query: 'ai safety' }, { clerkId: 'clerk-a' } as ClerkUserProfile);
        expect(updated.report).toBe('Report with new article');
        expect(genAiService.generateResearchReport).toHaveBeenCalledTimes(3);

        // 5. force: true bypasses cache
        const forced = await controller.researchArticles({ query: 'ai safety', force: true }, { clerkId: 'clerk-a' } as ClerkUserProfile);
        expect(forced.report).toBe('Forced fresh report');
        expect(genAiService.generateResearchReport).toHaveBeenCalledTimes(4);
    });
});