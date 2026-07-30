import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ArticleChunks } from './entities/article-chunks.entity';

export interface RelevantChunk {
    id: string;
    articleId: string;
    chunkText: string;
    chunkIndex: number;
    distance: number;
    articleTitle: string;
}

/**
 * Mirrors lb-laterleaf/src/repositories/article-chunks.repository.ts.
 * Embeddings are inserted/queried via raw SQL (cast to `vector`) since
 * TypeORM has no native pgvector type — matching how ArticlesService
 * handles Article.embedding.
 */
@Injectable()
export class ArticleChunksService {
    constructor(
        @InjectRepository(ArticleChunks)
        private readonly articleChunksRepository: Repository<ArticleChunks>,
    ) { }

    countByArticleId(articleId: string): Promise<number> {
        return this.articleChunksRepository.count({ where: { articleId } });
    }

    async create(data: {
        articleId: string;
        chunkText: string;
        chunkIndex: number;
        chunkEmbedding?: number[];
    }): Promise<void> {
        if (data.chunkEmbedding && data.chunkEmbedding.length > 0) {
            const embeddingString = `[${data.chunkEmbedding.join(',')}]`;
            await this.articleChunksRepository.query(
                `INSERT INTO article_chunks (article_id, chunk_text, chunk_index, chunk_embedding)
                 VALUES ($1, $2, $3, $4::vector)`,
                [data.articleId, data.chunkText, data.chunkIndex, embeddingString],
            );
        } else {
            await this.articleChunksRepository.query(
                `INSERT INTO article_chunks (article_id, chunk_text, chunk_index)
                 VALUES ($1, $2, $3)`,
                [data.articleId, data.chunkText, data.chunkIndex],
            );
        }
    }

    /**
     * Find the most relevant chunks for a query across a user's saved articles.
     * Uses pgvector cosine distance on chunk embeddings.
     */
    async findRelevantChunks(
        queryEmbedding: number[],
        userId: string,
        options?: { limit?: number; articleIds?: string[] },
    ): Promise<RelevantChunk[]> {
        const limit = options?.limit ?? 20;
        const embeddingString = `[${queryEmbedding.join(',')}]`;

        let sql: string;
        let params: any[];

        if (options?.articleIds?.length) {
            // Scoped to specific articles (for chat)
            sql = `
        SELECT ac.id, ac.article_id AS "articleId", ac.chunk_text AS "chunkText",
               ac.chunk_index AS "chunkIndex",
               (ac.chunk_embedding <=> $1) AS distance,
               a.title AS "articleTitle"
        FROM public.article_chunks ac
        INNER JOIN public.articles a ON ac.article_id = a.id
        WHERE ac.article_id = ANY($2)
          AND ac.chunk_embedding IS NOT NULL
        ORDER BY distance
        LIMIT $3;
      `;
            params = [embeddingString, options.articleIds, limit];
        } else {
            // Scoped to all of a user's saved articles (for research)
            sql = `
        SELECT ac.id, ac.article_id AS "articleId", ac.chunk_text AS "chunkText",
               ac.chunk_index AS "chunkIndex",
               (ac.chunk_embedding <=> $1) AS distance,
               a.title AS "articleTitle"
        FROM public.article_chunks ac
        INNER JOIN public.articles a ON ac.article_id = a.id
        INNER JOIN public.user_articles ua ON a.id = ua.article_id
        WHERE ua.user_id = $2
          AND ac.chunk_embedding IS NOT NULL
        ORDER BY distance
        LIMIT $3;
      `;
            params = [embeddingString, userId, limit];
        }

        return this.articleChunksRepository.query(sql, params);
    }
}
