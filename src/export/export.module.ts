import { Module } from '@nestjs/common';
import { ExportController } from './export.controller';
import { UsersModule } from '../users/users.module';
import { ArticlesModule } from '../articles/articles.module';
import { CollectionsModule } from '../collections/collections.module';
import { TagsModule } from '../tags/tags.module';

@Module({
    imports: [UsersModule, ArticlesModule, CollectionsModule, TagsModule],
    controllers: [ExportController],
})
export class ExportModule { }
