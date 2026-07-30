import { BadRequestException, Body, Controller, ForbiddenException, Get, Post, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { ArticlesService } from '../articles/articles.service';
import { GenAiService } from '../genai/gen-ai.service';
import { CollectionsService } from './collections.service';
import { ArticleCollectionsService } from './article-collections.service';

/**
 */
@UseGuards(ClerkAuthGuard)
@Controller('collections')
export class CollectionSuggestionController {
    constructor(
        private readonly usersService: UsersService,
        private readonly articlesService: ArticlesService,
        private readonly collectionsService: CollectionsService,
        private readonly articleCollectionsService: ArticleCollectionsService,
        private readonly genAiService: GenAiService,
    ) { }

    /**
     * Suggests existing collections for an article/content by comparing its
     * embedding against the average embedding of each of the user's
     * collections ("vibe" matching). Collections need at least 3 articles
     * with embeddings to be considered.
     */
    @Post('suggest-for-article')
    async suggestForArticle(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Body() request: { articleId?: string; title?: string; content?: string },
    ): Promise<string[]> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new ForbiddenException('USER_NOT_FOUND');
        }

        let title = request.title;
        let content = request.content;
        let targetEmbedding: number[] | null | undefined;

        if (request.articleId) {
            const article = await this.articlesService.findById(request.articleId);
            if (article) {
                title = article.title;
                content = article.content || article.excerpt || '';
                // Reuse the existing embedding if available to avoid regeneration cost.
                targetEmbedding = await this.articlesService.getEmbeddingVector(request.articleId);
            }
        }

        if (!targetEmbedding && (!title || !content)) {
            if (!title) {
                throw new BadRequestException('Article title and content (or valid articleId) are required');
            }
            content = '';
        }

        // Fetch the user's collections and (a bounded set of) their linked articles' embeddings.
        const collections = await this.collectionsService.find({ where: { userId: user.id } });
        if (collections.length === 0) {
            return [];
        }

        if (!targetEmbedding) {
            targetEmbedding = await this.genAiService.generateEmbeddings(`${title}\n${content}`, {
                purpose: 'search_query',
            });
        }

        if (!targetEmbedding || targetEmbedding.length === 0) {
            return [];
        }

        const collectionIds = collections.map((c) => c.id);
        const links = await this.articleCollectionsService.findRecentByCollectionIds(collectionIds, 10);

        const articleIds = [...new Set(links.map((link) => link.articleId).filter((id): id is string => !!id))];
        const embeddingsByArticleId = await this.articlesService.getEmbeddingsForIds(articleIds);

        const articleIdsByCollection = new Map<string, string[]>();
        for (const link of links) {
            if (!link.collectionId || !link.articleId) continue;
            const group = articleIdsByCollection.get(link.collectionId) ?? [];
            group.push(link.articleId);
            articleIdsByCollection.set(link.collectionId, group);
        }

        const scoredCollections = collections.map((collection) => {
            const articleIdsForCollection = articleIdsByCollection.get(collection.id) ?? [];
            const validEmbeddings = articleIdsForCollection
                .map((articleId) => embeddingsByArticleId.get(articleId))
                .filter((embedding): embedding is number[] => !!embedding && embedding.length > 0);

            // Require at least 3 articles to form a valid "collection vibe".
            if (validEmbeddings.length < 3) {
                return { name: collection.name, score: 0, count: validEmbeddings.length };
            }

            const avgEmbedding = new Array(768).fill(0);
            for (const vec of validEmbeddings) {
                for (let i = 0; i < 768; i++) {
                    avgEmbedding[i] += vec[i];
                }
            }
            for (let i = 0; i < 768; i++) {
                avgEmbedding[i] /= validEmbeddings.length;
            }

            const similarity = this.cosineSimilarity(targetEmbedding!, avgEmbedding);
            return { name: collection.name, score: similarity, count: validEmbeddings.length };
        });

        const filtered = scoredCollections.filter((c) => c.score > 0.65).sort((a, b) => b.score - a.score);

        if (filtered.length > 0) {
            console.log(`🔍 Collection Suggestions for "${title}":`);
            filtered.forEach((c) => {
                console.log(`   - ${c.name}: ${c.score.toFixed(4)} (based on ${c.count} articles)`);
            });
        }

        return filtered.slice(0, 3).map((c) => c.name);
    }

    private cosineSimilarity(vecA: number[], vecB: number[]): number {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * Disabled in lb-laterleaf ("Disabled for now to save costs") — ported
     * as a no-op stub for parity/frontend compatibility.
     */
    @Get('suggest-new')
    async suggestNew(): Promise<{ name: string; emoji: string; reason: string }[]> {
        return [];
    }
}
