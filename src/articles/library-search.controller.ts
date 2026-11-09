import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { GenAiService } from '../genai/gen-ai.service';
import { ArticlesService } from './articles.service';
import { UserArticlesService } from './user-articles.service';

interface LibrarySearchItem {
    id: string;
    url: string;
    title: string;
    excerpt?: string;
    imageUrl?: string;
    siteName?: string;
    siteIcon?: string;
    ogImage?: string;
    ogDescription?: string;
    themeColor?: string;
    author?: string;
    createdAt?: Date | string;
    updatedAt?: Date | string;
    userArticleId?: string;
    isBookmarked: boolean;
    isLiked: boolean;
    isArchived: boolean;
    isPastedText?: boolean;
    content?: string;
    summary?: string;
    audioLocation?: string | null;
    distance: number;
}

@UseGuards(ClerkAuthGuard)
@Controller('search')
export class LibrarySearchController {
    constructor(
        private readonly usersService: UsersService,
        private readonly articlesService: ArticlesService,
        private readonly userArticlesService: UserArticlesService,
        private readonly genAiService: GenAiService,
    ) { }

    @Get()
    async search(
        @Query('q') rawQuery: string,
        @Query('mode') mode: string,
        @CurrentUser() currentUser: ClerkUserProfile,
    ): Promise<{ results: Array<Omit<LibrarySearchItem, 'distance'>> }> {
        const query = rawQuery?.trim();
        if (!query) return { results: [] };

        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) return { results: [] };

        let results: LibrarySearchItem[];
        if (mode === 'semantic') {
            const queryEmbedding = await this.genAiService.generateEmbeddings(query, { purpose: 'search_query' });
            if (queryEmbedding.length === 0) return { results: [] };

            const [articles, pastedEntries] = await Promise.all([
                this.articlesService.semanticSearch(queryEmbedding, user.id, 20),
                this.userArticlesService.semanticSearchPasted(queryEmbedding, user.id, 20),
            ]);

            results = [
                ...articles.map((article) => {
                    const row = article as typeof article & {
                        isBookmarked?: boolean;
                        isLiked?: boolean;
                        isArchived?: boolean;
                        userArticleId?: string;
                        distance?: number;
                    };
                    return {
                        ...row,
                        title: row.title || 'Untitled',
                        isBookmarked: Boolean(row.isBookmarked),
                        isLiked: Boolean(row.isLiked),
                        isArchived: Boolean(row.isArchived),
                        distance: Number(row.distance),
                    };
                }),
                ...pastedEntries.map((entry) => ({
                    id: `pasted-${entry.userArticleId}`,
                    userArticleId: entry.userArticleId,
                    url: '',
                    title: entry.title,
                    excerpt: entry.excerpt,
                    content: entry.content,
                    siteName: entry.siteName,
                    summary: entry.summary,
                    audioLocation: entry.audioLocation,
                    createdAt: entry.createdAt,
                    updatedAt: entry.updatedAt,
                    isBookmarked: entry.isBookmarked,
                    isLiked: entry.isLiked,
                    isArchived: entry.isArchived,
                    isPastedText: true,
                    distance: Number(entry.distance),
                })),
            ];
        } else {
            const [articles, pastedEntries] = await Promise.all([
                this.articlesService.keywordSearch(query, user.id),
                this.userArticlesService.keywordSearchPasted(query, user.id),
            ]);
            results = [
                ...articles.map((article) => ({
                    ...article,
                    title: article.title || 'Untitled',
                    isBookmarked: Boolean((article as typeof article & { isBookmarked?: boolean }).isBookmarked),
                    isLiked: Boolean((article as typeof article & { isLiked?: boolean }).isLiked),
                    isArchived: Boolean((article as typeof article & { isArchived?: boolean }).isArchived),
                    distance: 0,
                })),
                ...pastedEntries.map((entry) => ({
                    id: `pasted-${entry.userArticleId}`,
                    userArticleId: entry.userArticleId,
                    url: '',
                    title: entry.title,
                    excerpt: entry.excerpt,
                    content: entry.content,
                    siteName: entry.siteName,
                    summary: entry.summary,
                    audioLocation: entry.audioLocation,
                    createdAt: entry.createdAt,
                    updatedAt: entry.updatedAt,
                    isBookmarked: entry.isBookmarked,
                    isLiked: entry.isLiked,
                    isArchived: entry.isArchived,
                    isPastedText: true,
                    distance: 0,
                })),
            ];
        }

        return {
            results: results
                .sort((first, second) => first.distance - second.distance)
                .slice(0, 20)
                .map(({ distance: _distance, ...result }) => result),
        };
    }
}