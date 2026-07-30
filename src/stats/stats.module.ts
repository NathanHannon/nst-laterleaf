import { Module } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { UsersModule } from '../users/users.module';
import { ArticlesModule } from '../articles/articles.module';
import { TagsModule } from '../tags/tags.module';

@Module({
    imports: [UsersModule, ArticlesModule, TagsModule],
    controllers: [StatsController],
})
export class StatsModule { }
