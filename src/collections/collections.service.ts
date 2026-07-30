import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindManyOptions, FindOptionsWhere, In, Repository } from 'typeorm';
import { Collection } from './entities/collection.entity';

@Injectable()
export class CollectionsService {
    constructor(
        @InjectRepository(Collection)
        private readonly collectionsRepository: Repository<Collection>,
    ) { }

    create(data: Partial<Collection>): Promise<Collection> {
        const collection = this.collectionsRepository.create(data);
        return this.collectionsRepository.save(collection);
    }

    findById(id: string): Promise<Collection | null> {
        return this.collectionsRepository.findOne({ where: { id } });
    }

    findByIdsForUser(ids: string[], userId: string): Promise<Collection[]> {
        if (ids.length === 0) return Promise.resolve([]);
        return this.collectionsRepository.find({
            where: { id: In(ids), userId },
        });
    }

    find(options?: FindManyOptions<Collection>): Promise<Collection[]> {
        return this.collectionsRepository.find(options);
    }

    count(where?: FindOptionsWhere<Collection>): Promise<number> {
        return this.collectionsRepository.count({ where });
    }

    async updateAll(
        partial: Partial<Collection>,
        where: FindOptionsWhere<Collection>,
    ): Promise<{ count: number }> {
        const result = await this.collectionsRepository.update(where, partial);
        return { count: result.affected ?? 0 };
    }

    async updateById(id: string, partial: Partial<Collection>): Promise<void> {
        await this.collectionsRepository.update({ id }, partial);
    }

    async deleteById(id: string): Promise<void> {
        await this.collectionsRepository.delete({ id });
    }

    /**
     * Bulk-deletes all of a user's Collections. Used by the Clerk
     * `user.deleted` webhook handler's cascade cleanup.
     */
    async deleteAllForUser(userId: string): Promise<number> {
        const result = await this.collectionsRepository.delete({ userId });
        return result.affected ?? 0;
    }
}
