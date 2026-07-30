import { Module } from '@nestjs/common';
import { ArticlesModule } from '../articles/articles.module';
import { GenaiModule } from '../genai/genai.module';
import { StorageModule } from '../storage/storage.module';
import { JobQueueModule } from './job-queue.module';
import { JobWorkerService } from './job-worker.service';

@Module({
    imports: [JobQueueModule, ArticlesModule, GenaiModule, StorageModule],
    providers: [JobWorkerService],
    exports: [JobQueueModule, JobWorkerService],
})
export class JobsModule { }
