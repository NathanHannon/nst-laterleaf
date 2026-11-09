import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { LibrarySearchController } from './library-search.controller';

describe('LibrarySearchController', () => {
    it('returns semantic article and pasted-text results for the authenticated user', async () => {
        const usersService = {
            findByClerkId: jest.fn().mockResolvedValue({ id: 'user-a' }),
        };
        const articlesService = {
            semanticSearch: jest.fn().mockResolvedValue([{
                id: 'article-a', title: 'AI trends', url: 'https://example.test', siteName: 'Example News',
                summary: 'Saved summary', audioLocation: 'https://cdn.example.test/audio.mp3', distance: 0.1,
            }]),
        };
        const userArticlesService = {
            semanticSearchPasted: jest.fn().mockResolvedValue([{
                userArticleId: 'paste-a', title: 'AI notes', content: 'Notes', excerpt: 'Notes',
                siteName: 'Pasted text', summary: 'Paste summary', audioLocation: 'https://cdn.example.test/paste.mp3',
                createdAt: new Date(), updatedAt: new Date(), isBookmarked: true, isLiked: false, isArchived: false,
                distance: 0.2,
            }]),
        };
        const genAiService = {
            generateEmbeddings: jest.fn().mockResolvedValue([0.1, 0.2]),
        };
        const controller = new LibrarySearchController(
            usersService as never,
            articlesService as never,
            userArticlesService as never,
            genAiService as never,
        );

        const result = await controller.search('AI', 'semantic', { clerkId: 'clerk-a' } as ClerkUserProfile);

        expect(articlesService.semanticSearch).toHaveBeenCalledWith([0.1, 0.2], 'user-a', 20);
        expect(userArticlesService.semanticSearchPasted).toHaveBeenCalledWith([0.1, 0.2], 'user-a', 20);
        expect(result.results.map((item) => item.id)).toEqual(['article-a', 'pasted-paste-a']);
        expect(result.results[0]).toMatchObject({
            siteName: 'Example News',
            summary: 'Saved summary',
            audioLocation: 'https://cdn.example.test/audio.mp3',
        });
        expect(result.results[1]).toMatchObject({
            siteName: 'Pasted text',
            summary: 'Paste summary',
            audioLocation: 'https://cdn.example.test/paste.mp3',
            isBookmarked: true,
        });
    });

    it('returns keyword matches from the authenticated user’s library', async () => {
        const usersService = { findByClerkId: jest.fn().mockResolvedValue({ id: 'user-a' }) };
        const articlesService = {
            keywordSearch: jest.fn().mockResolvedValue([{
                id: 'article-a', title: 'AI trends', siteName: 'Example News', summary: 'Saved summary',
                audioLocation: 'https://cdn.example.test/audio.mp3',
            }]),
        };
        const userArticlesService = {
            keywordSearchPasted: jest.fn().mockResolvedValue([{
                userArticleId: 'paste-a', title: 'AI notes', excerpt: 'Notes', content: 'Notes',
                siteName: 'Pasted text', summary: 'Paste summary', audioLocation: 'https://cdn.example.test/paste.mp3',
                createdAt: new Date(), updatedAt: new Date(), isBookmarked: false, isLiked: false, isArchived: false,
            }]),
        };
        const controller = new LibrarySearchController(
            usersService as never,
            articlesService as never,
            userArticlesService as never,
            {} as never,
        );

        const result = await controller.search('AI', 'keyword', { clerkId: 'clerk-a' } as ClerkUserProfile);

        expect(articlesService.keywordSearch).toHaveBeenCalledWith('AI', 'user-a');
        expect(userArticlesService.keywordSearchPasted).toHaveBeenCalledWith('AI', 'user-a');
        expect(result.results.map((item) => item.id)).toEqual(['article-a', 'pasted-paste-a']);
        expect(result.results[0]).toMatchObject({ siteName: 'Example News', summary: 'Saved summary' });
        expect(result.results[1]).toMatchObject({ siteName: 'Pasted text', summary: 'Paste summary' });
    });
});