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
});