import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { ArticlesService } from '../articles/articles.service';
import { UserArticlesService } from '../articles/user-articles.service';
import { GenAiService } from '../genai/gen-ai.service';
import { TagsService } from './tags.service';
import { UserArticleTagsService } from './user-article-tags.service';
import { Tag } from './entities/tag.entity';

/**
 */
@UseGuards(ClerkAuthGuard)
@Controller('tags')
export class TagsController {
    constructor(
        private readonly usersService: UsersService,
        private readonly userArticlesService: UserArticlesService,
        private readonly articlesService: ArticlesService,
        private readonly tagsService: TagsService,
        private readonly userArticleTagsService: UserArticleTagsService,
        private readonly genAiService: GenAiService,
    ) { }

    /**
     * Suggests tags for a UserArticle: a mix of the AI-generated
     * `suggestedTags` stored on the UserArticle (from summarization) and
     * similar existing tags from the global tag pool (via pgvector
     * similarity against the article's embedding).
     */
    @Get('suggest/:userArticleId')
    async suggestTags(@CurrentUser() currentUser: ClerkUserProfile, @Param('userArticleId') userArticleId: string): Promise<Tag[]> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('User not found.');
        }

        // 1. Verify ownership and get the article's embedding.
        const userArticle = await this.userArticlesService.findById(userArticleId);
        if (!userArticle || userArticle.userId !== user.id) {
            throw new NotFoundException('User article not found or permission denied.');
        }

        if (!userArticle.articleId) {
            return [];
        }

        const embedding = await this.articlesService.getEmbeddingVector(userArticle.articleId);
        if (!embedding) {
            return []; // No embedding to compare against
        }

        // 2. Get existing tags to exclude them from suggestions.
        const existingLinks = await this.userArticleTagsService.findByUserArticleId(userArticleId);
        const existingTags = await this.tagsService.findByIds(existingLinks.map((link) => link.tagId));
        const existingTagNames = existingTags.map((tag) => tag.name.toLowerCase());

        const suggestions: Tag[] = [];

        // AI-suggested tags stored on the UserArticle (from summarization).
        if (userArticle.suggestedTags && Array.isArray(userArticle.suggestedTags)) {
            for (const tagName of userArticle.suggestedTags) {
                if (!existingTagNames.includes(tagName.toLowerCase())) {
                    suggestions.push({ name: tagName, id: `suggested-${tagName}` } as Tag);
                }
            }
        }

        // Similar existing tags from the global tag pool.
        const existingTagIds = existingTags.map((tag) => tag.id).filter(Boolean);
        const similarTags = await this.tagsService.findSimilar(embedding, existingTagIds, 5);
        for (const tagWithScore of similarTags) {
            if (!existingTagNames.includes(tagWithScore.name.toLowerCase())) {
                suggestions.push(tagWithScore);
            }
        }

        return suggestions.slice(0, 8);
    }

    /**
     * Finds or creates a global Tag by name (generating its embedding if
     * new) and links it to the given UserArticle.
     */
    @Post('add-to-article')
    async addTagToUserArticle(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Body() tagData: { userArticleId: string; name: string },
    ): Promise<Tag> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('User not found.');
        }

        // 1. Verify ownership of the UserArticle.
        const userArticle = await this.userArticlesService.findById(tagData.userArticleId);
        if (!userArticle || userArticle.userId !== user.id) {
            throw new NotFoundException('User article not found or permission denied.');
        }

        // 2. Normalize the tag name.
        const normalizedTagName = tagData.name.toLowerCase().trim();
        if (!normalizedTagName) {
            throw new BadRequestException('Tag name cannot be empty.');
        }

        // 3. Find or create the master tag.
        let tag = await this.tagsService.findByName(normalizedTagName);
        if (!tag) {
            const embedding = await this.genAiService.generateEmbeddings(normalizedTagName);
            tag = await this.tagsService.create({ name: normalizedTagName });
            if (embedding && embedding.length > 0) {
                await this.tagsService.saveEmbedding(tag.id, embedding);
            }
        }

        // 4. Link the tag to the article if not already linked.
        const existingLink = await this.userArticleTagsService.findLink(tagData.userArticleId, tag.id);
        if (!existingLink) {
            await this.userArticleTagsService.create(tagData.userArticleId, tag.id);
        }

        return tag;
    }
}
