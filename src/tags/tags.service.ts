import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { In, Repository } from 'typeorm';
import { Tag } from './entities/tag.entity';

@Injectable()
export class TagsService {
    constructor(
        @InjectRepository(Tag)
        private readonly tagsRepository: Repository<Tag>,
    ) { }

    findById(id: string): Promise<Tag | null> {
        return this.tagsRepository.findOne({ where: { id } });
    }

    findByIds(ids: string[]): Promise<Tag[]> {
        if (ids.length === 0) return Promise.resolve([]);
        return this.tagsRepository.find({ where: { id: In(ids) } });
    }

    findByName(name: string): Promise<Tag | null> {
        return this.tagsRepository.findOne({ where: { name } });
    }

    create(data: Omit<Partial<Tag>, 'id' | 'embedding'>): Promise<Tag> {
        const tag = this.tagsRepository.create({ ...data, id: randomUUID() });
        return this.tagsRepository.save(tag);
    }

    /**
     * Saves a pgvector embedding via raw SQL (explicit `::vector` cast),
     * matching the write convention used for `Article.embedding` /
     * `ArticleChunks.chunkEmbedding` elsewhere in this codebase.
     */
    async saveEmbedding(tagId: string, embedding: number[]): Promise<void> {
        const embeddingString = `[${embedding.join(',')}]`;
        await this.tagsRepository.query(`UPDATE tags SET embedding = $1::vector WHERE id = $2`, [
            embeddingString,
            tagId,
        ]);
    }

    /**
     * Finds the tags whose embeddings are most similar (pgvector cosine
     * distance) to the given embedding, excluding `excludeIds` and filtering
     * out low-relevance matches below `minSimilarity`.
     */
    async findSimilar(
        embedding: number[],
        excludeIds: string[] = [],
        limit = 5,
        minSimilarity = 0.45,
    ): Promise<(Tag & { similarity: number })[]> {
        const embeddingString = `[${embedding.join(',')}]`;
        const maxDistance = 1 - minSimilarity;

        const baseSelect = `
            SELECT
                id,
                name,
                created_at as "createdAt",
                updated_at as "updatedAt",
                1 - (embedding <=> $1) as similarity
            FROM public.tags
            WHERE embedding IS NOT NULL
              AND (embedding <=> $1) <= $2`;

        if (excludeIds.length > 0) {
            const query = `
                ${baseSelect}
                  AND id != ALL($3)
                ORDER BY embedding <=> $1 ASC
                LIMIT $4;
            `;
            return this.tagsRepository.query(query, [embeddingString, maxDistance, excludeIds, limit]);
        }

        const query = `
            ${baseSelect}
            ORDER BY embedding <=> $1 ASC
            LIMIT $3;
        `;
        return this.tagsRepository.query(query, [embeddingString, maxDistance, limit]);
    }

    async updateByIds(ids: string[], partial: Partial<Tag>): Promise<number> {
        if (ids.length === 0) return 0;
        const result = await this.tagsRepository.update({ id: In(ids) }, partial);
        return result.affected ?? 0;
    }

    async deleteByIds(ids: string[]): Promise<number> {
        if (ids.length === 0) return 0;
        const result = await this.tagsRepository.delete({ id: In(ids) });
        return result.affected ?? 0;
    }
}
