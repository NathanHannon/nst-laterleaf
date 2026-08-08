import { BadRequestException, Body, Controller, ForbiddenException, Get, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { GenAiService } from './gen-ai.service';
import { GenerationService } from './generation.service';
import type { GenerationModel, GenerationProviderName } from './providers/generation-provider.interface';

interface CompareGenerationRequest {
    prompt: string;
    model: GenerationModel;
    providers: GenerationProviderName[];
}

interface CompareGenerationResult {
    provider: GenerationProviderName;
    model?: string;
    text?: string;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
    durationMs: number;
    error?: string;
}

/**
 */
@UseGuards(ClerkAuthGuard)
@Controller('ai')
export class GenAiController {
    constructor(
        private readonly genAiService: GenAiService,
        private readonly generationService: GenerationService,
        private readonly usersService: UsersService,
        private readonly configService: ConfigService,
    ) { }

    private requireAdmin(currentUser: ClerkUserProfile): void {
        const adminClerkIds = this.configService
            .get<string>('ADMIN_CLERK_IDS')
            ?.split(',')
            .map((id) => id.trim());

        if (adminClerkIds?.includes(currentUser.clerkId) || currentUser.publicMetadata?.role === 'admin') {
            return;
        }

        throw new ForbiddenException('Admin access required');
    }

    @Get('tts-voices')
    async getTtsVoices(@CurrentUser() currentUser: ClerkUserProfile): Promise<object[]> {
        const dbUser = await this.usersService.findByClerkId(currentUser.clerkId);
        const isProUser = dbUser?.isPro ?? false;

        return this.genAiService.getTTSVoices(isProUser);
    }

    @Post('compare')
    async compareProviders(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Body() body: CompareGenerationRequest,
    ): Promise<{ results: CompareGenerationResult[] }> {
        this.requireAdmin(currentUser);

        const prompt = body.prompt?.trim();
        const allowedModels: GenerationModel[] = ['free', 'pro', 'podcast'];
        const providers = [...new Set(body.providers || [])].filter(
            (provider): provider is GenerationProviderName => provider === 'gemini' || provider === 'openai-compatible',
        );

        if (!prompt || prompt.length > 20_000) {
            throw new BadRequestException('Prompt must contain between 1 and 20,000 characters');
        }
        if (!allowedModels.includes(body.model) || providers.length === 0) {
            throw new BadRequestException('A valid model tier and at least one provider are required');
        }

        const results = await Promise.all(
            providers.map(async (provider): Promise<CompareGenerationResult> => {
                const startedAt = performance.now();
                try {
                    const result = await this.generationService.generateTextWithProvider(provider, {
                        prompt,
                        model: body.model,
                    });
                    return {
                        provider,
                        ...result,
                        durationMs: Math.round(performance.now() - startedAt),
                    };
                } catch (error) {
                    return {
                        provider,
                        durationMs: Math.round(performance.now() - startedAt),
                        error: error instanceof Error ? error.message : 'Provider request failed',
                    };
                }
            }),
        );

        return { results };
    }
}
