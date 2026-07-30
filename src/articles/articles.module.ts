import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Article } from './entities/article.entity';
import { UserArticle } from './entities/user-article.entity';
import { ArticleChunks } from './entities/article-chunks.entity';
import { ArticlesService } from './articles.service';
import { UserArticlesService } from './user-articles.service';
import { ArticleChunksService } from './article-chunks.service';
import { ArticlesController } from './articles.controller';
import { UserMeArticlesController } from './user-me-articles.controller';
import { ChatController } from './chat.controller';
import { ArticleTranslationController } from './article-translation.controller';
import { ResearchController } from './research.controller';
import { AnnotationController } from './annotation.controller';
import { UsersModule } from '../users/users.module';
import { ContentExtractionModule } from '../content-extraction/content-extraction.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { StorageModule } from '../storage/storage.module';
import { GenaiModule } from '../genai/genai.module';
import { JobQueueModule } from '../jobs/job-queue.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([Article, UserArticle, ArticleChunks]),
        UsersModule,
        ContentExtractionModule,
        ContentModerationModule,
        StorageModule,
        GenaiModule,
        JobQueueModule,
    ],
    providers: [ArticlesService, UserArticlesService, ArticleChunksService],
    controllers: [ArticlesController, UserMeArticlesController, ChatController, ArticleTranslationController, ResearchController, AnnotationController],
    exports: [ArticlesService, UserArticlesService, ArticleChunksService],
})
export class ArticlesModule { }
