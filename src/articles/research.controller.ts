import { createHash } from 'crypto';
import {
    Body,
    Controller,
    ForbiddenException,
    NotFoundException,
    Post,
    UnprocessableEntityException,
    UseGuards,
} from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { ArticlesService } from './articles.service';
import { ArticleChunksService } from './article-chunks.service';
import { UserArticlesService } from './user-articles.service';
import { GenAiService } from '../genai/gen-ai.service';

interface ResearchResponse {
    report: string;
    articleCount: number;
    articleIds: string[];
    sources: { id: string; title: string; url: string }[];
}

interface CachedResearchEntry {
    response: ResearchResponse;
    expiresAt: number;
}

const RESEARCH_CACHE_MAX_ENTRIES = 200;
const RESEARCH_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 */
@UseGuards(ClerkAuthGuard)
@Controller('articles')
export class ResearchController {
    private readonly reportCache = new Map<string, CachedResearchEntry>();

    constructor(
        private readonly usersService: UsersService,
        private readonly articlesService: ArticlesService,
        private readonly articleChunksService: ArticleChunksService,
        private readonly userArticlesService: UserArticlesService,
        private readonly genAiService: GenAiService,
    ) { }

    private buildReportCacheKey(userId: string, query: string, limit: number, sourceIds: string[]): string {
        const normalizedQuery = query.trim().replace(/\s+/g, ' ').toLowerCase();
        const sortedSourceIds = [...sourceIds].sort();
        return createHash('sha256')
            .update(JSON.stringify([userId, normalizedQuery, limit, sortedSourceIds]))
            .digest('hex');
    }

    private getCachedReport(key: string): ResearchResponse | undefined {
        const entry = this.reportCache.get(key);
        if (!entry) return undefined;
        if (Date.now() > entry.expiresAt) {
            this.reportCache.delete(key);
            return undefined;
        }
        // Refresh LRU recency
        this.reportCache.delete(key);
        this.reportCache.set(key, entry);
        return {
            ...entry.response,
            articleIds: [...entry.response.articleIds],
            sources: entry.response.sources.map((s) => ({ ...s })),
        };
    }

    private setCachedReport(key: string, response: ResearchResponse): void {
        if (this.reportCache.has(key)) {
            this.reportCache.delete(key);
        } else if (this.reportCache.size >= RESEARCH_CACHE_MAX_ENTRIES) {
            const oldestKey = this.reportCache.keys().next().value;
            if (oldestKey !== undefined) {
                this.reportCache.delete(oldestKey);
            }
        }
        this.reportCache.set(key, {
            response: {
                ...response,
                articleIds: [...response.articleIds],
                sources: response.sources.map((s) => ({ ...s })),
            },
            expiresAt: Date.now() + RESEARCH_CACHE_TTL_MS,
        });
    }

    clearReportCache(): void {
        this.reportCache.clear();
    }

    @Post('research')
    async researchArticles(
        @Body() body: { query: string; limit?: number; force?: boolean },
        @CurrentUser() currentUser: ClerkUserProfile,
    ): Promise<ResearchResponse> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new NotFoundException('User profile not found.');
        }

        const publicMetadata = currentUser.publicMetadata || {};
        const hasProAccess = user.isPro || publicMetadata.role === 'admin';
        if (!hasProAccess) {
            throw new ForbiddenException('Research is available to Pro subscribers only.');
        }

        const limit = body.limit ?? 15;

        // 1. Generate query embedding.
        const queryEmbedding = await this.genAiService.generateEmbeddings(body.query, {
            purpose: 'search_query',
        });
        if (queryEmbedding.length === 0) {
            throw new UnprocessableEntityException('Could not process search query. Please try rephrasing.');
        }

        // 2. Find relevant saved articles and pasted entries owned by this user.
        const [articles, pastedEntries] = await Promise.all([
            this.articlesService.semanticSearch(queryEmbedding, user.id, limit),
            this.userArticlesService.semanticSearchPasted(queryEmbedding, user.id, limit),
        ]);
        const sources = [
            ...articles.map((article) => ({
                id: article.id,
                title: article.title || 'Untitled',
                url: article.url || '',
                excerpt: article.excerpt ?? undefined,
                content: article.content ?? undefined,
                distance: Number((article as typeof article & { distance: number }).distance),
            })),
            ...pastedEntries.map((entry) => ({
                id: `pasted-${entry.userArticleId}`,
                title: entry.title || 'Pasted text',
                url: '',
                excerpt: entry.excerpt,
                content: entry.content,
                distance: Number(entry.distance),
            })),
        ].sort((first, second) => first.distance - second.distance).slice(0, limit);

        if (sources.length === 0) {
            return {
                report: 'No items in your library are relevant to this query. Try saving more articles or pasted text on this topic first.',
                articleCount: 0,
                articleIds: [],
                sources: [],
            };
        }

        const cacheKey = this.buildReportCacheKey(
            user.id,
            body.query,
            limit,
            sources.map((source) => source.id),
        );
        if (!body.force) {
            const cached = this.getCachedReport(cacheKey);
            if (cached) {
                return cached;
            }
        }

        // 3. Retrieve the most relevant chunks across these articles for deep context.
        const relevantChunks = articles.length > 0
            ? await this.articleChunksService.findRelevantChunks(queryEmbedding, user.id, { limit: 12 })
            : [];

        // 4. Synthesize a research report using chunk-level context.
        const report = await this.genAiService.generateResearchReport(
            body.query,
            sources,
            relevantChunks.length > 0
                ? relevantChunks.map((c) => ({ articleTitle: c.articleTitle, chunkText: c.chunkText }))
                : undefined,
        );

        const response: ResearchResponse = {
            report,
            articleCount: sources.length,
            articleIds: sources.map((source) => source.id),
            sources: sources.map(({ id, title, url }) => ({ id, title, url })),
        };
        this.setCachedReport(cacheKey, response);

        return response;
    }
}
