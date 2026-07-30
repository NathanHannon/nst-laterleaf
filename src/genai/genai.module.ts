import { Module } from '@nestjs/common';
import { GenAiService } from './gen-ai.service';
import { AudioProcessingService } from './audio-processing.service';
import { GenAiController } from './gen-ai.controller';
import { UsersModule } from '../users/users.module';

@Module({
    imports: [UsersModule],
    providers: [GenAiService, AudioProcessingService],
    controllers: [GenAiController],
    exports: [GenAiService, AudioProcessingService],
})
export class GenaiModule { }
