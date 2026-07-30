import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { CuratedFeed } from './entities/curated-feed.entity';

/**
 * the admin-only `CuratedFeedController` CRUD.
 */
@Injectable()
export class CuratedFeedsService {
    constructor(
        @InjectRepository(CuratedFeed)
        private readonly curatedFeedsRepository: Repository<CuratedFeed>,
    ) { }

    find(where?: FindOptionsWhere<CuratedFeed>): Promise<CuratedFeed[]> {
        return this.curatedFeedsRepository.find({ where });
    }

    findActive(): Promise<CuratedFeed[]> {
        return this.curatedFeedsRepository.find({ where: { isActive: true } });
    }

    async findById(id: string): Promise<CuratedFeed> {
        const feed = await this.curatedFeedsRepository.findOne({ where: { id } });
        if (!feed) {
            throw new NotFoundException(`CuratedFeed with id ${id} not found`);
        }
        return feed;
    }

    create(data: Partial<CuratedFeed>): Promise<CuratedFeed> {
        const feed = this.curatedFeedsRepository.create(data);
        return this.curatedFeedsRepository.save(feed);
    }

    async updateById(id: string, partial: Partial<CuratedFeed>): Promise<void> {
        await this.curatedFeedsRepository.update({ id }, partial);
    }

    async deleteById(id: string): Promise<void> {
        await this.curatedFeedsRepository.delete({ id });
    }
}
