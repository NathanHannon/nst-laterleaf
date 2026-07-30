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
     * distance) to the given embedding, excluding `excludeIds`. Mirrors
     * `TagRepository.findSimilar` in lb-laterleaf.
     */
    async findSimilar(
        embedding: number[],
        excludeIds: string[] = [],
        limit = 5,
    ): Promise<(Tag & { similarity: number })[]> {
        const embeddingString = `[${embedding.join(',')}]`;
        const exclusionClause =
            excludeIds.length > 0
                ? `AND id NOT IN (${excludeIds.map((id) => `'${id}'`).join(',')})`
                : '';

        const query = `
            SELECT
                id,
                name,
                created_at as "createdAt",
                updated_at as "updatedAt",
                1 - (embedding <=> $1) as similarity
            FROM public.tags
            WHERE embedding IS NOT NULL ${exclusionClause}
            ORDER BY similarity DESC
            LIMIT $2;
        `;

        return this.tagsRepository.query(query, [embeddingString, limit]);
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
