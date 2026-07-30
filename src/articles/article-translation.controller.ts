import { BadRequestException, Body, Controller, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { ArticlesService } from './articles.service';
import { GenAiService } from '../genai/gen-ai.service';

/**
 * Ports lb-laterleaf/src/controllers/article-translation.controller.ts.
 */
@UseGuards(ClerkAuthGuard)
@Controller('articles')
export class ArticleTranslationController {
    constructor(
        private readonly articlesService: ArticlesService,
        private readonly genAiService: GenAiService,
    ) { }

    @Post(':id/translate')
    async translateArticle(
        @Param('id') id: string,
        @Body() request: { targetLanguage: string },
    ): Promise<{ translation: string; language: string; cached: boolean }> {
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
