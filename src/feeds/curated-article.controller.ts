import { Controller, Get, Query } from '@nestjs/common';
import { CuratedArticlesService } from './curated-articles.service';
import { CuratedArticle } from './entities/curated-article.entity';

/**
 * Public (unauthenticated) endpoint exposing the latest curated articles
 * for the Discover page's "New from Around the Web" section.
 */
@Controller('curated-articles')
export class CuratedArticleController {
    constructor(private readonly curatedArticlesService: CuratedArticlesService) { }

    @Get()
    find(@Query('limit') limit?: string): Promise<CuratedArticle[]> {
        const parsedLimit = limit ? parseInt(limit, 10) : 30;
        return this.curatedArticlesService.findLatest(parsedLimit);
    }
}
