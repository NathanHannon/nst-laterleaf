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
import { GenAiService } from '../genai/gen-ai.service';

interface ResearchResponse {
    report: string;
    articleCount: number;
    articleIds: string[];
    sources: { id: string; title: string; url: string }[];
}

/**
 */
@UseGuards(ClerkAuthGuard)
@Controller('articles')
export class ResearchController {
    constructor(
        private readonly usersService: UsersService,
        private readonly articlesService: ArticlesService,
        private readonly articleChunksService: ArticleChunksService,
        private readonly genAiService: GenAiService,
    ) { }

    @Post('research')
    async researchArticles(
        @Body() body: { query: string; limit?: number },
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

        // 2. Find relevant articles (for source attribution).
        const articles = await this.articlesService.semanticSearch(queryEmbedding, user.id, limit);
        if (articles.length === 0) {
            return {
                report: 'No articles in your library are relevant to this query. Try saving more articles on this topic first.',
                articleCount: 0,
                articleIds: [],
                sources: [],
            };
        }

        // 3. Retrieve the most relevant chunks across these articles for deep context.
        const relevantChunks = await this.articleChunksService.findRelevantChunks(queryEmbedding, user.id, {
            limit: 12,
        });

        // 4. Synthesize a research report using chunk-level context.
        const report = await this.genAiService.generateResearchReport(
            body.query,
            articles.map((a) => ({
                id: a.id,
                title: a.title || 'Untitled',
                excerpt: a.excerpt ?? undefined,
                content: a.content ?? undefined,
            })),
            relevantChunks.length > 0
                ? relevantChunks.map((c) => ({ articleTitle: c.articleTitle, chunkText: c.chunkText }))
                : undefined,
        );

        return {
            report,
            articleCount: articles.length,
            articleIds: articles.map((a) => a.id),
            sources: articles.map((a) => ({ id: a.id, title: a.title || 'Untitled', url: a.url || '' })),
        };
    }
}
