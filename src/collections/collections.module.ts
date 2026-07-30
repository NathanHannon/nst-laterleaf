import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Collection } from './entities/collection.entity';
import { ArticleCollection } from './entities/article-collection.entity';
import { CollectionsService } from './collections.service';
import { ArticleCollectionsService } from './article-collections.service';
import { CollectionsController } from './collections.controller';
import { CollectionArticlesController } from './collection-articles.controller';
import { UserCollectionsController } from './user-collections.controller';
import { ArticleCollectionsLookupController } from './article-collections-lookup.controller';
import { CollectionSuggestionController } from './collection-suggestion.controller';
import { UsersModule } from '../users/users.module';
import { ArticlesModule } from '../articles/articles.module';
import { GenaiModule } from '../genai/genai.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([Collection, ArticleCollection]),
        UsersModule,
        ArticlesModule,
        GenaiModule,
    ],
    providers: [CollectionsService, ArticleCollectionsService],
    controllers: [
        // NOTE: CollectionSuggestionController must be registered BEFORE
        // CollectionsController so its literal `/collections/suggest-new`
        // route is matched before CollectionsController's `GET /collections/:id`.
        CollectionSuggestionController,
        CollectionsController,
        CollectionArticlesController,
        UserCollectionsController,
        ArticleCollectionsLookupController,
    ],
    exports: [CollectionsService, ArticleCollectionsService],
})
export class CollectionsModule { }
