import {
    computeCandidateScore,
    computeRelatedLibraryScore,
    RecommendationCandidate,
} from '../articles/articles.service';
import {
    InterestItem,
    allocateClusterBudgets,
    applyDismissalPenalties,
    clusterInterests,
    computeItemWeight,
    cosineSimilarity,
    mergeClusterCandidates,
    rerankWithDiversity,
    samplePopularWithDiversity,
} from './recommendation.algorithms';

const NOW = new Date('2026-11-27T12:00:00Z').getTime();
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function makeItem(overrides: Partial<InterestItem> & { id: string; embedding: number[] }): InterestItem {
    return {
        createdAt: daysAgo(1),
        isLiked: false,
        isBookmarked: false,
        tagCount: 0,
        status: 'unread',
        progressPercentage: 0,
        ...overrides,
    };
}

function makeCandidate(
    overrides: Partial<RecommendationCandidate> & { id: string; weightedScore: number },
): RecommendationCandidate {
    return {
        url: `https://site-${overrides.id}.com/post`,
        title: `Article ${overrides.id}`,
        semanticScore: overrides.semanticScore ?? 0.8,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
        ...overrides,
    } as RecommendationCandidate;
}

describe('recommendation algorithms', () => {
    describe('computeCandidateScore', () => {
        it('prevents a viral low-relevance article from outranking a relevant article with 0 bookmarks', () => {
            const relevantUnpopular = computeCandidateScore({
                semanticScore: 0.85,
                bookmarkCount: 0,
                saveCount: 1,
                publishedOrCreatedAt: new Date(NOW),
                nowMs: NOW,
            });
            const viralMediocre = computeCandidateScore({
                semanticScore: 0.5,
                bookmarkCount: 500,
                saveCount: 1000,
                publishedOrCreatedAt: new Date(NOW),
                nowMs: NOW,
            });

            expect(relevantUnpopular).toBeGreaterThan(viralMediocre);
        });

        it('rewards higher bookmark conversion and fresher publication dates at equal relevance', () => {
            const freshHighQuality = computeCandidateScore({
                semanticScore: 0.8,
                bookmarkCount: 10,
                saveCount: 12,
                publishedOrCreatedAt: daysAgo(2),
                nowMs: NOW,
            });
            const staleLowQuality = computeCandidateScore({
                semanticScore: 0.8,
                bookmarkCount: 0,
                saveCount: 20,
                publishedOrCreatedAt: daysAgo(400),
                nowMs: NOW,
            });

            expect(freshHighQuality).toBeGreaterThan(staleLowQuality);
        });
    });

    describe('computeItemWeight', () => {
        it('incorporates bookmarks, likes, reading progress, highlights, and lastReadAt recency', () => {
            const plainUnread = computeItemWeight(
                makeItem({ id: 'a', embedding: [1, 0], createdAt: daysAgo(50), status: 'unread', progressPercentage: 0 }),
                NOW,
            );
            const recentlyReadEngaged = computeItemWeight(
                makeItem({
                    id: 'b',
                    embedding: [1, 0],
                    createdAt: daysAgo(50),
                    lastReadAt: daysAgo(1),
                    status: 'read',
                    progressPercentage: 100,
                    isLiked: true,
                    isBookmarked: true,
                    tagCount: 2,
                    hasHighlights: true,
                    hasChat: true,
                    hasSummaryOrAudio: true,
                }),
                NOW,
            );

            expect(recentlyReadEngaged).toBeGreaterThan(plainUnread * 5);
        });

        it('gently decays stale unengaged unread articles older than 30 days', () => {
            const recentUnread = computeItemWeight(
                makeItem({ id: 'a', embedding: [1, 0], createdAt: daysAgo(29) }),
                NOW,
            );
            const staleUnread = computeItemWeight(
                makeItem({ id: 'b', embedding: [1, 0], createdAt: daysAgo(31) }),
                NOW,
            );

            // Beyond exponential decay (~2.3%), the 0.75 stale factor creates a clear step down.
            expect(staleUnread).toBeLessThan(recentUnread * 0.8);
        });
    });

    describe('clusterInterests', () => {
        it('handles exactly 5 items cleanly without crashing or producing undefined centroids', () => {
            const items = [
                makeItem({ id: '1', embedding: [1, 0, 0] }),
                makeItem({ id: '2', embedding: [0.98, 0.2, 0] }),
                makeItem({ id: '3', embedding: [0, 1, 0] }),
                makeItem({ id: '4', embedding: [0.1, 0.99, 0] }),
                makeItem({ id: '5', embedding: [0, 0, 1] }),
            ];

            const clusters = clusterInterests(items, { nowMs: NOW });
            expect(clusters.length).toBeGreaterThanOrEqual(2);
            for (const cluster of clusters) {
                expect(cluster.centroid).toHaveLength(3);
                expect(cluster.centroid.every((v) => Number.isFinite(v))).toBe(true);
                const norm = Math.sqrt(cluster.centroid.reduce((sum, v) => sum + v * v, 0));
                expect(norm).toBeCloseTo(1, 5);
            }
        });

        it('separates distinct topics even when the 3 most recent saves are on the same topic', () => {
            // Most recent 3 items are all topic A ([1, 0, 0]); older items are topic B ([0, 1, 0]) and C ([0, 0, 1]).
            const items: InterestItem[] = [
                makeItem({ id: 'a1', embedding: [1, 0, 0], createdAt: daysAgo(1) }),
                makeItem({ id: 'a2', embedding: [0.99, 0.05, 0], createdAt: daysAgo(2) }),
                makeItem({ id: 'a3', embedding: [0.98, 0.02, 0.01], createdAt: daysAgo(3) }),
                makeItem({ id: 'a4', embedding: [0.97, 0.04, 0], createdAt: daysAgo(4) }),
                makeItem({ id: 'b1', embedding: [0, 1, 0], createdAt: daysAgo(10), isBookmarked: true }),
                makeItem({ id: 'b2', embedding: [0.05, 0.99, 0], createdAt: daysAgo(12), isLiked: true }),
                makeItem({ id: 'b3', embedding: [0, 0.98, 0.05], createdAt: daysAgo(14) }),
                makeItem({ id: 'c1', embedding: [0, 0, 1], createdAt: daysAgo(15), isBookmarked: true }),
                makeItem({ id: 'c2', embedding: [0, 0.04, 0.99], createdAt: daysAgo(16) }),
                makeItem({ id: 'c3', embedding: [0.03, 0, 0.99], createdAt: daysAgo(18) }),
            ];

            const clusters = clusterInterests(items, { nowMs: NOW });
            expect(clusters).toHaveLength(3);

            // Each of the 3 orthogonal axes should be represented by a cluster centroid.
            const matchesAxis = (axis: number[]) =>
                clusters.some((c) => cosineSimilarity(c.centroid, axis) > 0.95);
            expect(matchesAxis([1, 0, 0])).toBe(true);
            expect(matchesAxis([0, 1, 0])).toBe(true);
            expect(matchesAxis([0, 0, 1])).toBe(true);
        });

        it('merges near-duplicate clusters when all items belong to one narrow topic', () => {
            const items = Array.from({ length: 10 }, (_, idx) =>
                makeItem({ id: `narrow-${idx}`, embedding: [1, 0.02 * idx, 0] }),
            );

            const clusters = clusterInterests(items, { nowMs: NOW });
            expect(clusters).toHaveLength(1);
            expect(clusters[0].size).toBe(10);
        });
    });

    describe('allocateClusterBudgets & mergeClusterCandidates', () => {
        it('allocates larger budgets to heavier clusters while keeping a minimum floor', () => {
            const budgets = allocateClusterBudgets(
                [
                    { centroid: [1, 0], totalWeight: 90, size: 15 },
                    { centroid: [0, 1], totalWeight: 10, size: 2 },
                ],
                60,
                8,
            );

            expect(budgets[0]).toBeGreaterThan(budgets[1]);
            expect(budgets[1]).toBeGreaterThanOrEqual(8);
        });

        it('keeps the highest weightedScore when deduplicating across clusters and adds a bridge bonus', () => {
            const clusters = [
                { centroid: [1, 0], totalWeight: 10, size: 5 },
                { centroid: [0, 1], totalWeight: 10, size: 5 },
            ];
            const cluster0 = [
                makeCandidate({ id: 'shared', weightedScore: 0.9 }),
                makeCandidate({ id: 'only0', weightedScore: 0.9 }),
            ];
            // Same ID appears in cluster 1 with a LOWER score — must not overwrite 0.9!
            const cluster1 = [makeCandidate({ id: 'shared', weightedScore: 0.4 })];

            const merged = mergeClusterCandidates([cluster0, cluster1], clusters);
            const shared = merged.find((m) => m.article.id === 'shared')!;
            const only0 = merged.find((m) => m.article.id === 'only0')!;

            expect(shared.matchedClusterCount).toBe(2);
            expect(shared.sourceCluster).toBe(0);
            expect(shared.mergedScore).toBeGreaterThan(only0.mergedScore);
        });
    });

    describe('applyDismissalPenalties', () => {
        it('penalizes candidates near a dismissed topic without distorting unrelated topics', () => {
            const clusters = [
                { centroid: [1, 0], totalWeight: 10, size: 5 },
                { centroid: [0, 1], totalWeight: 10, size: 5 },
            ];
            const merged = mergeClusterCandidates(
                [
                    [makeCandidate({ id: 'crypto', weightedScore: 0.85, embeddingVector: [0.99, 0.1] })],
                    [makeCandidate({ id: 'cooking', weightedScore: 0.85, embeddingVector: [0.0, 1.0] })],
                ],
                clusters,
            );

            const penalized = applyDismissalPenalties(merged, [[1, 0]]);
            const crypto = penalized.find((c) => c.article.id === 'crypto')!;
            const cooking = penalized.find((c) => c.article.id === 'cooking')!;

            expect(crypto.adjustedScore).toBeLessThan(crypto.mergedScore * 0.3);
            expect(cooking.adjustedScore).toBeCloseTo(cooking.mergedScore, 6);
        });

        it('applies domain fatigue when a user repeatedly dismisses from the same domain', () => {
            const clusters = [{ centroid: [1, 0], totalWeight: 10, size: 5 }];
            const merged = mergeClusterCandidates(
                [
                    [
                        makeCandidate({ id: 'a', weightedScore: 0.8, url: 'https://noisy.example.com/1' }),
                        makeCandidate({ id: 'b', weightedScore: 0.8, url: 'https://fresh.example.com/1' }),
                    ],
                ],
                clusters,
            );

            const penalized = applyDismissalPenalties(
                merged,
                [],
                new Map([['noisy.example.com', 3]]),
            );
            const noisy = penalized.find((c) => c.article.id === 'a')!;
            const fresh = penalized.find((c) => c.article.id === 'b')!;

            expect(noisy.adjustedScore).toBeCloseTo(fresh.adjustedScore * 0.7, 5);
        });
    });

    describe('rerankWithDiversity', () => {
        it('caps articles per domain and demotes near-duplicate stories via MMR', () => {
            const clusters = [{ centroid: [1, 0, 0], totalWeight: 10, size: 5 }];
            const candidates = mergeClusterCandidates(
                [
                    [
                        makeCandidate({
                            id: 'd1',
                            weightedScore: 0.95,
                            url: 'https://same.com/1',
                            embeddingVector: [1, 0, 0],
                        }),
                        makeCandidate({
                            id: 'd2-near-dup',
                            weightedScore: 0.94,
                            url: 'https://other.com/1',
                            embeddingVector: [0.995, 0.09, 0], // > 0.92 cosine sim to d1
                        }),
                        makeCandidate({
                            id: 'd3-same-domain',
                            weightedScore: 0.9,
                            url: 'https://same.com/2',
                            embeddingVector: [0, 1, 0],
                        }),
                        makeCandidate({
                            id: 'd4-same-domain-over-cap',
                            weightedScore: 0.89,
                            url: 'https://same.com/3',
                            embeddingVector: [0, 0, 1],
                        }),
                        makeCandidate({
                            id: 'd5-diverse',
                            weightedScore: 0.85,
                            url: 'https://third.com/1',
                            embeddingVector: [0, 0, 1],
                        }),
                    ],
                ],
                clusters,
            );

            const picked = rerankWithDiversity(candidates, { limit: 4, maxPerDomain: 2 });
            const ids = picked.map((p) => p.article.id);

            expect(ids[0]).toBe('d1');
            // Diverse distinct stories should beat the near-duplicate of d1.
            expect(ids[1]).not.toBe('d2-near-dup');
            // Domain cap of 2 for same.com should prefer third.com over a 3rd same.com article.
            const sameDomainCount = picked.filter((p) => p.domain === 'same.com').length;
            expect(sameDomainCount).toBeLessThanOrEqual(2);
            expect(ids).toContain('d5-diverse');
        });
    });

    describe('samplePopularWithDiversity', () => {
        it('enforces maxPerDomain when enough other domains exist', () => {
            const pool = [
                makeCandidate({ id: '1', weightedScore: 1, url: 'https://a.com/1' }),
                makeCandidate({ id: '2', weightedScore: 1, url: 'https://a.com/2' }),
                makeCandidate({ id: '3', weightedScore: 1, url: 'https://a.com/3' }),
                makeCandidate({ id: '4', weightedScore: 1, url: 'https://b.com/1' }),
                makeCandidate({ id: '5', weightedScore: 1, url: 'https://c.com/1' }),
            ];

            const result = samplePopularWithDiversity(pool, { limit: 4, maxPerDomain: 2, rng: () => 0.5 });
            expect(result).toHaveLength(4);
            expect(result.filter((a) => a.url.includes('a.com'))).toHaveLength(2);
        });
    });

    describe('computeRelatedLibraryScore (anti-graveyard)', () => {
        it('surfaces forgotten unread and in-progress saves ahead of already-read articles', () => {
            const alreadyRead = computeRelatedLibraryScore({
                similarity: 0.8,
                status: 'read',
                isArchived: false,
                progressPercentage: 100,
                savedAt: daysAgo(2),
                nowMs: NOW,
            });
            const dustyUnread = computeRelatedLibraryScore({
                similarity: 0.68,
                status: 'unread',
                isArchived: false,
                progressPercentage: 0,
                savedAt: daysAgo(45),
                readingTime: 5,
                nowMs: NOW,
            });
            const halfRead = computeRelatedLibraryScore({
                similarity: 0.68,
                status: 'unread',
                isArchived: false,
                progressPercentage: 40,
                savedAt: daysAgo(10),
                nowMs: NOW,
            });

            expect(dustyUnread).toBeGreaterThan(alreadyRead);
            expect(halfRead).toBeGreaterThan(alreadyRead);
        });

        it('rewards older unread backlog and shared tags over freshly saved identical-similarity articles', () => {
            const justSaved = computeRelatedLibraryScore({
                similarity: 0.72,
                status: 'unread',
                savedAt: daysAgo(1),
                sharedTagCount: 0,
                nowMs: NOW,
            });
            const dustyWithTag = computeRelatedLibraryScore({
                similarity: 0.72,
                status: 'unread',
                savedAt: daysAgo(60),
                sharedTagCount: 1,
                nowMs: NOW,
            });

            expect(dustyWithTag).toBeGreaterThan(justSaved);
        });

        it('still allows a deeply relevant read article to outrank a barely related unread one', () => {
            const strongReadReference = computeRelatedLibraryScore({
                similarity: 0.92,
                status: 'read',
                progressPercentage: 100,
                nowMs: NOW,
            });
            const weakUnread = computeRelatedLibraryScore({
                similarity: 0.46,
                status: 'unread',
                savedAt: daysAgo(30),
                nowMs: NOW,
            });

            expect(strongReadReference).toBeGreaterThan(weakUnread);
        });
    });
});
