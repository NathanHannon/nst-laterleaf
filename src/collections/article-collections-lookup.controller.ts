import { Controller, ForbiddenException, Get, Param, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { CollectionsService } from './collections.service';
import { ArticleCollectionsService } from './article-collections.service';
import { Collection } from './entities/collection.entity';

/**
 * Ports the `GET /articles/{id}/collections` endpoint from
 * Collections module (rather than ArticlesModule) to avoid a circular
 * module dependency, since it needs CollectionsService for ownership
 * filtering.
 */
@UseGuards(ClerkAuthGuard)
@Controller('articles')
export class ArticleCollectionsLookupController {
    constructor(
        private readonly usersService: UsersService,
        private readonly collectionsService: CollectionsService,
        private readonly articleCollectionsService: ArticleCollectionsService,
    ) { }

    @Get(':id/collections')
    async getArticleCollections(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
    ): Promise<Collection[]> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new ForbiddenException('USER_NOT_FOUND');
        }

        const links = await this.articleCollectionsService.findByArticleId(id);
        const collectionIds = links
            .map((link) => link.collectionId)
            .filter((collectionId): collectionId is string => Boolean(collectionId));

        if (collectionIds.length === 0) {
            return [];
        }

        return this.collectionsService.findByIdsForUser(collectionIds, user.id);
    }
}
