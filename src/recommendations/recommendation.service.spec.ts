import { Article } from '../articles/entities/article.entity';
import { ArticlesService, RecommendationCandidate } from '../articles/articles.service';
import { UserArticlesService } from '../articles/user-articles.service';
import { UsersService } from '../users/users.service';
import { UserArticleTagsService } from '../tags/user-article-tags.service';
import { CuratedArticlesService } from '../feeds/curated-articles.service';
import { CuratedArticle } from '../feeds/entities/curated-article.entity';
import { RecommendationService } from './recommendation.service';
import { RecommendationController } from './recommendation.controller';

function candidate(id: string, weightedScore: number, embeddingVector: number[], url?: string): RecommendationCandidate {
    return Object.assign(new Article(), {
        id,
        title: `Title ${id}`,
        url: url ?? `https://${id}.example.com/article`,
        siteName: `${id}.example.com`,
        semanticScore: weightedScore,
        weightedScore,
        embeddingVector,
    }) as RecommendationCandidate;
}

describe('RecommendationService', () => {
    it('excludes dismissed articles in popular fallback', async () => {
        const articlesService = {
            findPopular: jest.fn().mockResolvedValue([
                candidate('pop-1', 0.9, [1, 0]),
                candidate('pop-2', 0.8, [0, 1]),
            ]),
        } as unknown as ArticlesService;

        const userArticlesService = {
            findAllForUser: jest.fn().mockResolvedValue([{ id: 'ua-1', articleId: 'saved-1' }]),
        } as unknown as UserArticlesService;

        const usersService = {
            findById: jest.fn().mockResolvedValue({
                id: 'user-1',
                dismissedArticleIds: ['dismissed-1', 'dismissed-2'],
            }),
        } as unknown as UsersService;

        const userArticleTagsService = {
            findByUserArticleIds: jest.fn().mockResolvedValue([]),
        } as unknown as UserArticleTagsService;

        const service = new RecommendationService(
            articlesService,
            userArticlesService,
            usersService,
            userArticleTagsService,
        );

        const result = await service.getPopularArticles('user-1', 12, 60, ['prev-1']);

        expect(result).toHaveLength(2);
        const [excludedIds] = jest.mocked(articlesService.findPopular).mock.calls[0];
        expect(excludedIds).toEqual(
            expect.arrayContaining(['saved-1', 'prev-1', 'dismissed-1', 'dismissed-2']),
        );
    });

    it('generates personalized recommendations for a 5-article user without falling back and strips internal fields', async () => {
        const userArticles = Array.from({ length: 5 }, (_, i) => ({
            id: `ua-${i}`,
            articleId: `art-${i}`,
            createdAt: new Date('2026-11-20T00:00:00Z'),
            isLiked: i === 0,
            isBookmarked: i === 1,
            status: i < 2 ? 'read' : 'unread',
            progressPercentage: i < 2 ? 100 : 0,
            highlights: i === 0 ? [{ id: 'h1', text: 'key quote' }] : [],
            chatHistory: [],
        }));

        const embeddings = new Map<string, number[]>([
            ['art-0', [1, 0, 0]],
            ['art-1', [0.98, 0.1, 0]],
            ['art-2', [0, 1, 0]],
            ['art-3', [0.1, 0.98, 0]],
            ['art-4', [0, 0, 1]],
        ]);

        const findSimilarWeighted = jest
            .fn()
            .mockResolvedValue([
                candidate('rec-1', 0.9, [0.99, 0.05, 0]),
                candidate('rec-2', 0.85, [0, 0.99, 0.05]),
            ]);
        const findPopular = jest.fn().mockResolvedValue([]);

        const articlesService = {
            getEmbeddingsForIds: jest.fn().mockImplementation((ids: string[]) => {
                const map = new Map<string, number[]>();
                for (const id of ids) {
                    if (embeddings.has(id)) map.set(id, embeddings.get(id)!);
                }
                return Promise.resolve(map);
            }),
            findByIds: jest.fn().mockResolvedValue([]),
            findSimilarWeighted,
            findPopular,
        } as unknown as ArticlesService;

        const userArticlesService = {
            findAllForUser: jest.fn().mockResolvedValue(userArticles),
        } as unknown as UserArticlesService;

        const usersService = {
            findById: jest.fn().mockResolvedValue({ id: 'user-1', dismissedArticleIds: [] }),
        } as unknown as UsersService;

        const userArticleTagsService = {
            findByUserArticleIds: jest.fn().mockResolvedValue([{ userArticleId: 'ua-0', tagId: 't-1' }]),
        } as unknown as UserArticleTagsService;

        const service = new RecommendationService(
            articlesService,
            userArticlesService,
            usersService,
            userArticleTagsService,
        );

        const recs = await service.generateForUser('user-1', 12, 60, []);

        expect(findPopular).not.toHaveBeenCalled();
        expect(findSimilarWeighted).toHaveBeenCalled();
        expect(recs.map((r) => r.id)).toEqual(expect.arrayContaining(['rec-1', 'rec-2']));
        expect((recs[0] as any).weightedScore).toBeUndefined();
        expect((recs[0] as any).semanticScore).toBeUndefined();
        expect((recs[0] as any).embeddingVector).toBeUndefined();
    });

    it('blends cold-start personalized picks with popular filler for users with 1-4 saved articles', async () => {
        const userArticles = [
            {
                id: 'ua-1',
                articleId: 'art-1',
                createdAt: new Date('2026-11-25T00:00:00Z'),
                isLiked: true,
                isBookmarked: false,
            },
        ];

        const articlesService = {
            getEmbeddingsForIds: jest.fn().mockResolvedValue(new Map([['art-1', [1, 0]]])),
            findByIds: jest.fn().mockResolvedValue([]),
            findSimilarWeighted: jest.fn().mockResolvedValue([
                candidate('p-1', 0.9, [0.99, 0.05]),
                candidate('p-2', 0.85, [0.95, 0.2]),
            ]),
            findPopular: jest.fn().mockResolvedValue([
                candidate('pop-1', 0.7, [0, 1]),
                candidate('pop-2', 0.6, [0, 1]),
            ]),
        } as unknown as ArticlesService;

        const service = new RecommendationService(
            articlesService,
            { findAllForUser: jest.fn().mockResolvedValue(userArticles) } as unknown as UserArticlesService,
            { findById: jest.fn().mockResolvedValue({ id: 'u1', dismissedArticleIds: [] }) } as unknown as UsersService,
            { findByUserArticleIds: jest.fn().mockResolvedValue([]) } as unknown as UserArticleTagsService,
        );

        const recs = await service.generateForUser('u1', 4, 20, []);
        expect(recs.map((r) => r.id)).toEqual(expect.arrayContaining(['p-1', 'p-2', 'pop-1', 'pop-2']));
        expect(recs).toHaveLength(4);
    });
});

describe('RecommendationController', () => {
    it('attempts personalized recommendations when user has 1 saved article and falls back to popular if empty', async () => {
        const generateForUser = jest.fn().mockResolvedValue([]);
        const getPopularArticles = jest.fn().mockResolvedValue([candidate('pop-1', 0.8, [1, 0])]);

        const controller = new RecommendationController(
            { generateForUser, getPopularArticles } as unknown as RecommendationService,
            { findByClerkId: jest.fn().mockResolvedValue({ id: 'u1' }) } as unknown as UsersService,
            { findAllForUser: jest.fn().mockResolvedValue([{ id: 'ua-1', articleId: 'a-1' }]) } as unknown as UserArticlesService,
        );

        const response = await controller.getRecommendations({}, { clerkId: 'clerk-1' } as any);
        expect(generateForUser).toHaveBeenCalledTimes(1);
        expect(getPopularArticles).toHaveBeenCalledTimes(1);
        expect(response.type).toBe('popular');
        expect(response.articles).toHaveLength(1);
    });
});

describe('CuratedArticlesService.findLatest', () => {
    it('interleaves curated articles round-robin across feeds so one feed cannot monopolize Discover', async () => {
        const rows: CuratedArticle[] = [
            { id: 'f1-1', feedId: 'feed-1', url: 'https://feed1.com/1', title: 'F1 #1' },
            { id: 'f1-2', feedId: 'feed-1', url: 'https://feed1.com/2', title: 'F1 #2' },
            { id: 'f1-3', feedId: 'feed-1', url: 'https://feed1.com/3', title: 'F1 #3' },
            { id: 'f2-1', feedId: 'feed-2', url: 'https://feed2.com/1', title: 'F2 #1' },
            { id: 'f2-2', feedId: 'feed-2', url: 'https://feed2.com/2', title: 'F2 #2' },
            { id: 'f3-1', feedId: 'feed-3', url: 'https://feed3.com/1', title: 'F3 #1' },
        ];

        const repo = { find: jest.fn().mockResolvedValue(rows) } as any;
        const service = new CuratedArticlesService(repo);

        const result = await service.findLatest(5);
        expect(result.map((r) => r.id)).toEqual(['f1-1', 'f2-1', 'f3-1', 'f1-2', 'f2-2']);
    });
});
