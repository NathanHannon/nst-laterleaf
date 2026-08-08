import { Module } from '@nestjs/common';
import { GenAiService } from './gen-ai.service';
import { AudioProcessingService } from './audio-processing.service';
import { GenAiController } from './gen-ai.controller';
import { UsersModule } from '../users/users.module';
import { GenerationService } from './generation.service';
import { GeminiGenerationAdapter } from './providers/gemini-generation.adapter';
import { OpenAiCompatibleGenerationAdapter } from './providers/openai-compatible-generation.adapter';

@Module({
    imports: [UsersModule],
    providers: [
        GenAiService,
        GenerationService,
        GeminiGenerationAdapter,
        OpenAiCompatibleGenerationAdapter,
        AudioProcessingService,
    ],
    controllers: [GenAiController],
    exports: [GenAiService, GenerationService, AudioProcessingService],
})
export class GenaiModule { }
