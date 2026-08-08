import { Module } from '@nestjs/common';
import { ArticlesModule } from '../articles/articles.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { JobQueueModule } from '../jobs/job-queue.module';
import { UsersModule } from '../users/users.module';
import { AdminController } from './admin.controller';

@Module({
    imports: [UsersModule, ArticlesModule, ContentModerationModule, JobQueueModule],
    controllers: [AdminController],
})
export class AdminModule { }