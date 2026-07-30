import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { Article } from '../articles/entities/article.entity';
import { UserArticle } from '../articles/entities/user-article.entity';
import { ArticleChunks } from '../articles/entities/article-chunks.entity';
import { Collection } from '../collections/entities/collection.entity';
import { ArticleCollection } from '../collections/entities/article-collection.entity';
import { Tag } from '../tags/entities/tag.entity';
import { UserArticleTag } from '../tags/entities/user-article-tag.entity';
import { BlockedDomain } from '../content-moderation/entities/blocked-domain.entity';
import { Feed } from '../feeds/entities/feed.entity';
import { FeedArticle } from '../feeds/entities/feed-article.entity';
import { UserFeed } from '../feeds/entities/user-feed.entity';
import { CuratedFeed } from '../feeds/entities/curated-feed.entity';
import { CuratedArticle } from '../feeds/entities/curated-article.entity';

/**
 * Resolves the SSL config for the database connection.
 * Priority:
 *  1. DATABASE_CA_CERT env var (base64-encoded) — use on App Platform / CI
 *  2. Local cert file — use in development
 *  3. rejectUnauthorized: false — fallback for trusted internal networks
 *
 * Mirrors lb-laterleaf/src/datasources/laterleaf.datasource.ts
 */
function buildSslConfig(configService: ConfigService): object {
    const caCert = configService.get<string>('DATABASE_CA_CERT');
    if (caCert) {
        return { ca: Buffer.from(caCert, 'base64').toString() };
    }
    const certPath = path.join(
        __dirname,
        '../../../certs/laterleaf-db-ca-certificate.crt',
    );
    if (fs.existsSync(certPath)) {
        return { ca: fs.readFileSync(certPath) };
    }
    return { rejectUnauthorized: false };
}

export function buildTypeOrmConfig(
    configService: ConfigService,
): TypeOrmModuleOptions {
    return {
        type: 'postgres',
        host: configService.get<string>('DATABASE_HOST'),
        port: parseInt(configService.get<string>('DATABASE_PORT') ?? '25060', 10),
        username: configService.get<string>('DATABASE_USER'),
        password: configService.get<string>('DATABASE_PASSWORD'),
        database: configService.get<string>('DATABASE_NAME'),
        ssl: buildSslConfig(configService),
        entities: [User, Article, UserArticle, ArticleChunks, Collection, ArticleCollection, Tag, UserArticleTag, BlockedDomain, Feed, FeedArticle, UserFeed, CuratedFeed, CuratedArticle],
        // Schema is managed via lb-laterleaf's `npm run migrate` for now.
        // Keep synchronize disabled to avoid clobbering the existing schema
        // while both backends coexist during the phased migration.
        synchronize: false,
    };
}
