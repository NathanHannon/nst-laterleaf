import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { buildTypeOrmConfig } from './config/typeorm.config';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ArticlesModule } from './articles/articles.module';
import { CollectionsModule } from './collections/collections.module';
import { TagsModule } from './tags/tags.module';
import { StorageModule } from './storage/storage.module';
import { ContentExtractionModule } from './content-extraction/content-extraction.module';
import { ContentModerationModule } from './content-moderation/content-moderation.module';
import { GenaiModule } from './genai/genai.module';
import { JobsModule } from './jobs/jobs.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { RecommendationsModule } from './recommendations/recommendations.module';
import { ExportModule } from './export/export.module';
import { ImportModule } from './import/import.module';
import { StatsModule } from './stats/stats.module';
import { FeedsModule } from './feeds/feeds.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: buildTypeOrmConfig,
    }),
    AuthModule,
    UsersModule,
    ArticlesModule,
    CollectionsModule,
    TagsModule,
    StorageModule,
    ContentExtractionModule,
    ContentModerationModule,
    GenaiModule,
    JobsModule,
    WebhooksModule,
    RecommendationsModule,
    ExportModule,
    ImportModule,
    StatsModule,
    FeedsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
