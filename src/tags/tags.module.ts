import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tag } from './entities/tag.entity';
import { UserArticleTag } from './entities/user-article-tag.entity';
import { TagsService } from './tags.service';
import { UserArticleTagsService } from './user-article-tags.service';
import { UserArticleTagsController } from './user-article-tags.controller';
import { TagsController } from './tags.controller';
import { UsersModule } from '../users/users.module';
import { ArticlesModule } from '../articles/articles.module';
import { GenaiModule } from '../genai/genai.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([Tag, UserArticleTag]),
        UsersModule,
        ArticlesModule,
        GenaiModule,
    ],
    providers: [TagsService, UserArticleTagsService],
    controllers: [UserArticleTagsController, TagsController],
    exports: [TagsService, UserArticleTagsService],
})
export class TagsModule { }
