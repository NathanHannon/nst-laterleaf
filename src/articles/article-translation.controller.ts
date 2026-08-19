import { BadRequestException, Body, Controller, NotFoundException, Param, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { ArticlesService } from './articles.service';
import { GenAiService } from '../genai/gen-ai.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';

/**
 */
@UseGuards(ClerkAuthGuard)
@Controller('articles')
export class ArticleTranslationController {
    constructor(
        private readonly articlesService: ArticlesService,
        private readonly genAiService: GenAiService,
        private readonly usersService: UsersService,
        private readonly rateLimitService: RateLimitService,
    ) { }

    @Post(':id/translate')
    async translateArticle(
        @Param('id') id: string,
        @Body() request: { targetLanguage: string },
        @CurrentUser() currentUser: ClerkUserProfile,
    ): Promise<{ translation: string; language: string; cached: boolean }> {
        // Burst rate limit: translations are LLM calls on full article content
        const dbUser = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!dbUser?.id) {
            throw new UnauthorizedException('User not found.');
        }
        await this.rateLimitService.enforce(dbUser.id, 'translate', [
            { limit: 5, windowSeconds: 60, label: '5 per minute' },
            { limit: 20, windowSeconds: 3600, label: '20 per hour' },
        ]);
        const article = await this.articlesService.findById(id);
        if (!article) {
            throw new NotFoundException('Article not found');
        }

        const { targetLanguage } = request;
        const existingTranslations = article.translations || {};

        if (existingTranslations[targetLanguage]) {
            console.log(`✅ [Translation] Returning cached translation for ${targetLanguage}`);
            return {
                translation: existingTranslations[targetLanguage],
                language: targetLanguage,
                cached: true,
            };
        }

        const contentToTranslate = article.contentHtml || article.content;
        if (!contentToTranslate) {
            throw new BadRequestException('Article has no content to translate');
        }

        console.log(`🌍 [Translation] Generating new translation for ${targetLanguage}...`);
        // We pass false for isProUser because we decided to standardize on Flash-Lite for everyone
        const translation = await this.genAiService.translateArticle(contentToTranslate, targetLanguage, false);

        const updatedTranslations = {
            ...existingTranslations,
            [targetLanguage]: translation,
        };

        await this.articlesService.updateById(id, { translations: updatedTranslations });

        return {
            translation,
            language: targetLanguage,
            cached: false,
        };
    }
}
