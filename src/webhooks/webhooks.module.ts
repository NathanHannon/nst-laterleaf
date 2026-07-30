import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { CollectionsModule } from '../collections/collections.module';
import { ArticlesModule } from '../articles/articles.module';
import { TagsModule } from '../tags/tags.module';
import { ClerkWebhookController } from './clerk-webhook.controller';
import { RevenuecatWebhookController } from './revenuecat-webhook.controller';

@Module({
    imports: [UsersModule, CollectionsModule, ArticlesModule, TagsModule],
    controllers: [ClerkWebhookController, RevenuecatWebhookController],
})
export class WebhooksModule { }
