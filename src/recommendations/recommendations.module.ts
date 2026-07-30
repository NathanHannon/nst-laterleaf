import { Module } from '@nestjs/common';
import { RecommendationService } from './recommendation.service';
import { RecommendationController } from './recommendation.controller';
import { ArticlesModule } from '../articles/articles.module';
import { UsersModule } from '../users/users.module';
import { TagsModule } from '../tags/tags.module';

@Module({
    imports: [ArticlesModule, UsersModule, TagsModule],
    providers: [RecommendationService],
    controllers: [RecommendationController],
    exports: [RecommendationService],
})
export class RecommendationsModule { }
