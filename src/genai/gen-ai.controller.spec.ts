import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import type { UsersService } from '../users/users.service';
import type { GenAiService } from './gen-ai.service';
import { GenAiController } from './gen-ai.controller';
import type { GenerationService } from './generation.service';

describe('GenAiController provider authorization', () => {
    const nonAdmin: ClerkUserProfile = {
        id: 'user_123',
        clerkId: 'user_123',
        publicMetadata: { role: 'user' },
        rawToken: {},
    };

    it('rejects a provider comparison body submitted by a non-admin', async () => {
        const generationService = {
            generateTextWithProvider: jest.fn(),
        } as unknown as GenerationService;
        const configService = {
            get: jest.fn().mockReturnValue('admin_456'),
        } as unknown as ConfigService;
        const controller = new GenAiController(
            {} as GenAiService,
            generationService,
            {} as UsersService,
            configService,
        );

        await expect(controller.compareProviders(nonAdmin, {
            prompt: 'Manipulated frontend request',
            model: 'pro',
            providers: ['openai-compatible'],
        })).rejects.toBeInstanceOf(ForbiddenException);
        expect(generationService.generateTextWithProvider).not.toHaveBeenCalled();
    });
});