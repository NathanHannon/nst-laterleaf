import { Controller, Get, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { ArticlesService } from '../articles/articles.service';
import { UserArticlesService } from '../articles/user-articles.service';
import { CollectionsService } from '../collections/collections.service';
import { ArticleCollectionsService } from '../collections/article-collections.service';
import { UserArticleTagsService } from '../tags/user-article-tags.service';
import { TagsService } from '../tags/tags.service';

interface ExportData {
    title: string;
    url: string;
    summary?: string;
    content?: string;
    dateAdded: string;
    isBookmarked: boolean;
    isArchived: boolean;
    collections: string[];
    tags: string[];
}

/**
 */
@UseGuards(ClerkAuthGuard)
@Controller('export')
export class ExportController {
    constructor(
        private readonly usersService: UsersService,
        private readonly articlesService: ArticlesService,
        private readonly userArticlesService: UserArticlesService,
        private readonly collectionsService: CollectionsService,
        private readonly articleCollectionsService: ArticleCollectionsService,
        private readonly userArticleTagsService: UserArticleTagsService,
        private readonly tagsService: TagsService,
    ) { }

    private async getUserExportData(currentUser: ClerkUserProfile): Promise<ExportData[]> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('User not found');
        }
        const userId = user.id;

        const userArticles = await this.userArticlesService.findAllForUser(userId);
        const articleIds = userArticles.map((ua) => ua.articleId).filter((id): id is string => Boolean(id));
        const articles = await this.articlesService.findByIds(articleIds);
        const articleById = new Map(articles.map((a) => [a.id, a]));

        const userCollections = await this.collectionsService.find({ where: { userId } });

        const exportData: ExportData[] = [];

        for (const userArticle of userArticles) {
            const article = userArticle.articleId ? articleById.get(userArticle.articleId) : undefined;
            if (!article) continue;

            // Get collections that contain this article.
            const articleCollections = userArticle.articleId
                ? await this.articleCollectionsService.findByArticleId(userArticle.articleId)
                : [];
            const articleCollectionIds = new Set(articleCollections.map((ac) => ac.collectionId));
            const collections = userCollections
                .filter((c) => c.id && articleCollectionIds.has(c.id))
                .map((c) => c.name)
                .filter((name): name is string => Boolean(name));

            // Get tags for this UserArticle.
            const tagLinks = userArticle.id
                ? await this.userArticleTagsService.findByUserArticleId(userArticle.id)
                : [];
            const tagIds = tagLinks.map((t) => t.tagId).filter((id): id is string => Boolean(id));
            const tagRecords = await this.tagsService.findByIds(tagIds);
            const tags = tagRecords.map((t) => t.name).filter((name): name is string => Boolean(name));

            exportData.push({
                title: article.title || 'Untitled',
                url: article.url,
                summary: userArticle.summary || article.excerpt || undefined,
                content: article.content || undefined,
                dateAdded: new Date(userArticle.createdAt).toISOString(),
                isBookmarked: userArticle.isBookmarked || false,
                isArchived: userArticle.isArchived || false,
                collections,
                tags,
            });
        }

        return exportData;
    }

    @Get('csv')
    async exportCsv(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Res({ passthrough: false }) res: Response,
    ): Promise<void> {
        const data = await this.getUserExportData(currentUser);

        const headers = ['Title', 'URL', 'Summary', 'Date Added', 'Bookmarked', 'Archived', 'Collections', 'Tags'];
        const csvRows = [headers.join(',')];

        for (const item of data) {
            const row = [
                this.escapeCsvField(item.title),
                this.escapeCsvField(item.url),
                this.escapeCsvField(item.summary || ''),
                this.escapeCsvField(new Date(item.dateAdded).toLocaleDateString()),
                item.isBookmarked ? 'Yes' : 'No',
                item.isArchived ? 'Yes' : 'No',
                this.escapeCsvField(item.collections.join(', ')),
                this.escapeCsvField(item.tags.join(', ')),
            ];
            csvRows.push(row.join(','));
        }

        const csvContent = csvRows.join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="laterleaf-export-${new Date().toISOString().split('T')[0]}.csv"`,
        );
        res.end(csvContent);
    }

    @Get('html')
    async exportHtml(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Res({ passthrough: false }) res: Response,
    ): Promise<void> {
        const data = await this.getUserExportData(currentUser);

        const collectionGroups: { [key: string]: ExportData[] } = {
            Uncategorized: [],
        };

        for (const item of data) {
            if (item.collections.length === 0) {
                collectionGroups['Uncategorized'].push(item);
            } else {
                for (const collection of item.collections) {
                    if (!collectionGroups[collection]) {
                        collectionGroups[collection] = [];
                    }
                    collectionGroups[collection].push(item);
                }
            }
        }

        let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<HTML>
<HEAD>
<TITLE>Later Leaf Bookmarks</TITLE>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
</HEAD>
<BODY>
<H1>Later Leaf Bookmarks</H1>
<DL><p>
`;

        for (const [collectionName, items] of Object.entries(collectionGroups)) {
            if (items.length === 0) continue;

            html += `    <DT><H3>${this.escapeHtml(collectionName)}</H3>\n`;
            html += `    <DL><p>\n`;

            for (const item of items) {
                const addDate = Math.floor(new Date(item.dateAdded).getTime() / 1000);
                const tags = item.tags.length > 0 ? ` TAGS="${this.escapeHtml(item.tags.join(','))}"` : '';
                const description = item.summary ? `<DD>${this.escapeHtml(item.summary)}` : '';

                html += `        <DT><A HREF="${this.escapeHtml(item.url)}" ADD_DATE="${addDate}"${tags}>${this.escapeHtml(item.title)}</A>\n`;
                if (description) {
                    html += `        ${description}\n`;
                }
            }

            html += `    </DL><p>\n`;
        }

        html += `</DL>
</BODY>
</HTML>`;

        res.setHeader('Content-Type', 'text/html');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="laterleaf-bookmarks-${new Date().toISOString().split('T')[0]}.html"`,
        );
        res.end(html);
    }

    @Get('json')
    async exportJson(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Res({ passthrough: false }) res: Response,
    ): Promise<void> {
        const data = await this.getUserExportData(currentUser);

        const exportJson = {
            exportDate: new Date().toISOString(),
            source: 'Later Leaf',
            version: '1.0',
            totalArticles: data.length,
            articles: data,
        };

        res.setHeader('Content-Type', 'application/json');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="laterleaf-export-${new Date().toISOString().split('T')[0]}.json"`,
        );
        res.end(JSON.stringify(exportJson, null, 2));
    }

    private escapeCsvField(field: string): string {
        if (field.includes(',') || field.includes('"') || field.includes('\n')) {
            return `"${field.replace(/"/g, '""')}"`;
        }
        return field;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}
