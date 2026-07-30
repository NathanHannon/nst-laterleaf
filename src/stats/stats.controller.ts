import { Controller, Get, InternalServerErrorException, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { UsersService } from '../users/users.service';
import { ArticlesService } from '../articles/articles.service';
import { UserArticlesService } from '../articles/user-articles.service';
import { UserArticleTagsService } from '../tags/user-article-tags.service';
import { TagsService } from '../tags/tags.service';

interface WrappedStats {
    year: number;
    totalSaved: number;
    totalRead: number;
    totalArchived: number;
    completionRate: number;
    topSource?: { name: string; count: number };
    topTags: { name: string; count: number }[];
    busiestMonth: { name: string; count: number };
    streak: number;
}

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 */
@UseGuards(ClerkAuthGuard)
@Controller('stats')
export class StatsController {
    constructor(
        private readonly usersService: UsersService,
        private readonly articlesService: ArticlesService,
        private readonly userArticlesService: UserArticlesService,
        private readonly userArticleTagsService: UserArticleTagsService,
        private readonly tagsService: TagsService,
    ) { }

    @Get('wrapped/:year')
    async getWrappedStats(
        @Param('year', ParseIntPipe) year: number,
        @CurrentUser() currentUser: ClerkUserProfile,
    ): Promise<WrappedStats> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new InternalServerErrorException('User not found');
        }
        const userId = user.id;
        const startDate = new Date(`${year}-01-01T00:00:00.000Z`);
        const endDate = new Date(`${year}-12-31T23:59:59.999Z`);

        // 1. Articles saved this year.
        const articlesSaved = await this.userArticlesService.findSavedInRange(userId, startDate, endDate);

        // 2. Articles read this year (status read/archived, updated in year).
        const articlesRead = await this.userArticlesService.findReadInRange(userId, startDate, endDate);

        // A. Totals
        const totalSaved = articlesSaved.length;
        const totalRead = articlesRead.filter((a) => a.status === 'read').length;
        const totalArchived = articlesRead.filter((a) => a.status === 'archived').length;
        const uniqueReadIds = new Set(articlesRead.map((a) => a.id));
        const completionRate = totalSaved > 0 ? (uniqueReadIds.size / totalSaved) * 100 : 0;

        // Fetch the underlying Article rows (siteName/url) for savings-source grouping.
        const articleIds = articlesSaved.map((ua) => ua.articleId).filter((id): id is string => Boolean(id));
        const articles = await this.articlesService.findByIds(articleIds);
        const articleById = new Map(articles.map((a) => [a.id, a]));

        // B. Top Sources (Domain)
        const sourceMap = new Map<string, number>();
        articlesSaved.forEach((ua) => {
            const article = ua.articleId ? articleById.get(ua.articleId) : undefined;
            if (article?.siteName) {
                sourceMap.set(article.siteName, (sourceMap.get(article.siteName) || 0) + 1);
            } else if (article?.url) {
                try {
                    const url = new URL(article.url);
                    const domain = url.hostname.replace('www.', '');
                    sourceMap.set(domain, (sourceMap.get(domain) || 0) + 1);
                } catch {
                    // ignore invalid urls
                }
            }
        });

        let topSource: { name: string; count: number } | undefined;
        let maxSourceCount = 0;
        sourceMap.forEach((count, name) => {
            if (count > maxSourceCount) {
                maxSourceCount = count;
                topSource = { name, count };
            }
        });

        // C. Top Tags
        const userArticleIds = articlesSaved.map((ua) => ua.id).filter((id): id is string => Boolean(id));
        const tagLinks = await this.userArticleTagsService.findByUserArticleIds(userArticleIds);
        const tagIds = [...new Set(tagLinks.map((t) => t.tagId).filter((id): id is string => Boolean(id)))];
        const tagRecords = await this.tagsService.findByIds(tagIds);
        const tagNameById = new Map(tagRecords.map((t) => [t.id, t.name]));

        const tagMap = new Map<string, number>();
        tagLinks.forEach((link) => {
            const name = link.tagId ? tagNameById.get(link.tagId) : undefined;
            if (name) {
                tagMap.set(name, (tagMap.get(name) || 0) + 1);
            }
        });

        const topTags = Array.from(tagMap.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        // D. Busiest Month (Saved)
        const monthMap = new Map<number, number>();
        articlesSaved.forEach((ua) => {
            const d = new Date(ua.createdAt);
            const m = d.getMonth();
            monthMap.set(m, (monthMap.get(m) || 0) + 1);
        });

        let busiestMonthIndex = 0;
        let maxMonthCount = 0;
        monthMap.forEach((count, idx) => {
            if (count > maxMonthCount) {
                maxMonthCount = count;
                busiestMonthIndex = idx;
            }
        });

        const busiestMonth = {
            name: MONTH_NAMES[busiestMonthIndex],
            count: maxMonthCount,
        };

        // E. Streak (simplified: max consecutive days with a 'read' action).
        const uniqueDates = Array.from(
            new Set(
                articlesRead
                    .map((a) => (a.lastReadAt ? new Date(a.lastReadAt).toISOString().split('T')[0] : null))
                    .filter((d): d is string => d !== null),
            ),
        ).sort();

        let currentStreak = 0;
        let maxStreak = 0;

        if (uniqueDates.length > 0) {
            currentStreak = 1;
            maxStreak = 1;
            for (let i = 1; i < uniqueDates.length; i++) {
                const prev = new Date(uniqueDates[i - 1]);
                const curr = new Date(uniqueDates[i]);
                const diffTime = Math.abs(curr.getTime() - prev.getTime());
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                if (diffDays === 1) {
                    currentStreak++;
                } else {
                    currentStreak = 1;
                }
                if (currentStreak > maxStreak) maxStreak = currentStreak;
            }
        }

        return {
            year,
            totalSaved,
            totalRead,
            totalArchived,
            completionRate,
            topSource,
            topTags,
            busiestMonth,
            streak: maxStreak,
        };
    }
}
