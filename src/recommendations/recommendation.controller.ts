import {
    Body,
    Controller,
    HttpCode,
    Post,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { UserArticlesService } from '../articles/user-articles.service';
import { Article } from '../articles/entities/article.entity';
import { RecommendationService } from './recommendation.service';

interface RecommendationResponse {
    type: 'personalized' | 'popular' | 'none';
    articles: Article[];
}

/**
 * Ports lb-laterleaf/src/controllers/recommendation.controller.ts.
 */
@UseGuards(ClerkAuthGuard)
@Controller('recommendations')
export class RecommendationController {
    constructor(
        private readonly recommendationService: RecommendationService,
        private readonly usersService: UsersService,
        private readonly userArticlesService: UserArticlesService,
    ) { }

    @Post()
    async getRecommendations(
        @Body() body: { previouslyRecommendedIds?: string[] },
        @CurrentUser() currentUser: ClerkUserProfile,
    ): Promise<RecommendationResponse> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('User not found to generate recommendations.');
        }
        const previouslyRecommendedIds = body.previouslyRecommendedIds ?? [];

        const savedArticles = await this.userArticlesService.findAllForUser(user.id);

        // Always try personalized first if the user has enough saved articles.
        if (savedArticles.length >= 5) {
            const personalizedArticles = await this.recommendationService.generateForUser(
                user.id,
                12,
                60,
                previouslyRecommendedIds,
            );

            if (personalizedArticles.length > 0) {
                return { type: 'personalized', articles: personalizedArticles };
            }
            // Fallback to popular if personalized returns nothing.
        }

        const popularArticles = await this.recommendationService.getPopularArticles(
            user.id,
            12,
            60,
            previouslyRecommendedIds,
        );

        if (popularArticles.length > 0) {
            return { type: 'popular', articles: popularArticles };
        }

        return { type: 'none', articles: [] };
    }

    @Post('dismiss')
    @HttpCode(204)
    async dismissRecommendation(
        @Body() body: { articleId: string },
        @CurrentUser() currentUser: ClerkUserProfile,
    ): Promise<void> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('User not found.');
        }

        const MAX_DISMISSED = 200;
        const dismissed = user.dismissedArticleIds ?? [];
        if (!dismissed.includes(body.articleId)) {
            dismissed.push(body.articleId);
            const trimmed = dismissed.length > MAX_DISMISSED ? dismissed.slice(-MAX_DISMISSED) : dismissed;
            await this.usersService.updateById(user.id, { dismissedArticleIds: trimmed });
        }
    }
}
