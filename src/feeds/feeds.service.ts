import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Feed } from './entities/feed.entity';

/**
 * `UserFeedController` (a user's personal RSS subscriptions) and
 * `FeedFetchingService`.
 */
@Injectable()
export class FeedsService {
    constructor(
        @InjectRepository(Feed)
        private readonly feedsRepository: Repository<Feed>,
    ) { }

    find(): Promise<Feed[]> {
        return this.feedsRepository.find();
    }

    findById(id: string): Promise<Feed | null> {
        return this.feedsRepository.findOne({ where: { id } });
    }

    findByUrl(url: string): Promise<Feed | null> {
        return this.feedsRepository.findOne({ where: { url } });
    }

    create(data: Partial<Feed>): Promise<Feed> {
        const feed = this.feedsRepository.create(data);
        return this.feedsRepository.save(feed);
    }

    async updateById(id: string, partial: Partial<Feed>): Promise<void> {
        await this.feedsRepository.update({ id }, partial);
    }
}
