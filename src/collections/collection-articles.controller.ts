import {
    Body,
    ConflictException,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    NotFoundException,
    Param,
    Post,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { ArticlesService } from '../articles/articles.service';
import { Article } from '../articles/entities/article.entity';
import { CollectionsService } from './collections.service';
import { ArticleCollectionsService } from './article-collections.service';
import { ArticleCollection } from './entities/article-collection.entity';

/**
 * (endpoints actually used by the frontend: list, link, unlink). The
 * `POST /collections/:id/articles` (create brand-new Article from the
 * collection side) and `PATCH`/`DELETE /collections/:id/articles`
 * (bulk operations on linked articles) are not called by the frontend and
 * are intentionally not exposed here.
 */
@UseGuards(ClerkAuthGuard)
@Controller('collections')
export class CollectionArticlesController {
    constructor(
        private readonly collectionsService: CollectionsService,
        private readonly articleCollectionsService: ArticleCollectionsService,
        private readonly articlesService: ArticlesService,
        private readonly usersService: UsersService,
    ) { }

    private async getOwnedCollection(collectionId: string, currentUser: ClerkUserProfile) {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('USER_NOT_FOUND');
        }
        const collection = await this.collectionsService.findById(collectionId);
        if (!collection || collection.userId !== user.id) {
            throw new ForbiddenException('ACCESS_DENIED');
        }
        return collection;
    }

    @Get(':id/articles')
    async find(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
    ): Promise<Article[]> {
        await this.getOwnedCollection(id, currentUser);
        const links = await this.articleCollectionsService.findByCollectionId(id);
        const articleIds = links
            .map((link) => link.articleId)
            .filter((articleId): articleId is string => Boolean(articleId));
        return this.articlesService.findByIds(articleIds);
    }

    @Post(':id/link-article')
    async linkArticle(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') collectionId: string,
        @Body() body: { articleId: string },
    ): Promise<ArticleCollection> {
        await this.getOwnedCollection(collectionId, currentUser);

        const existingLink = await this.articleCollectionsService.findLink(
            collectionId,
            body.articleId,
        );
        if (existingLink) {
            throw new ConflictException('Article already in collection');
        }

        return this.articleCollectionsService.create({
            collectionId,
            articleId: body.articleId,
            addedAt: new Date(),
        });
    }

    @Delete(':collectionId/unlink-article/:articleId')
    async unlinkArticle(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('collectionId') collectionId: string,
        @Param('articleId') articleId: string,
    ): Promise<void> {
        await this.getOwnedCollection(collectionId, currentUser);

        const link = await this.articleCollectionsService.findLink(collectionId, articleId);
        if (!link) {
            throw new NotFoundException('Article not found in collection');
        }

        await this.articleCollectionsService.deleteById(link.id);
    }
}
