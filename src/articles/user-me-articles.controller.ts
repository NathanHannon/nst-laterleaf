import { Controller, Get, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { ArticlesService } from './articles.service';
import { UserArticlesService } from './user-articles.service';
import { Article } from './entities/article.entity';

/**
 * (`GET /users/me/articles`). Unlike `GET /articles`, this returns bare
 * Article rows (no bookmark/archive/summary status merged in), matching
 * the original hasMany-through relation behavior.
 */
@UseGuards(ClerkAuthGuard)
@Controller('users/me')
export class UserMeArticlesController {
    constructor(
        private readonly usersService: UsersService,
        private readonly userArticlesService: UserArticlesService,
        private readonly articlesService: ArticlesService,
    ) { }

    @Get('articles')
    async findMyArticles(@CurrentUser() currentUser: ClerkUserProfile): Promise<Article[]> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('User not found.');
        }

        const links = await this.userArticlesService.findAllForUser(user.id);
        const articleIds = links
            .map((link) => link.articleId)
            .filter((id): id is string => Boolean(id));

        return this.articlesService.findByIds(articleIds);
    }
}
