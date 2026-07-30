import { Module } from '@nestjs/common';
import { JobQueueService } from './job-queue.service';

/**
 * Split out from JobsModule so that ArticlesModule can inject
 * JobQueueService (to enqueue chunking/summary/audio jobs) without creating
 * a circular dependency with JobsModule, which itself imports ArticlesModule
 * (for JobWorkerService's processing dependencies).
 */
@Module({
    providers: [JobQueueService],
    exports: [JobQueueService],
})
export class JobQueueModule { }
