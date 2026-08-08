import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ArticlesService } from '../articles/articles.service';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import type { BlockedDomainsService } from '../content-moderation/blocked-domains.service';
import type { JobQueueService } from '../jobs/job-queue.service';
import type { UsersService } from '../users/users.service';
import { AdminController } from './admin.controller';

jest.mock('../jobs/job-queue.service', () => ({
    JobQueueService: class JobQueueService { },
}));

describe('AdminController', () => {
    const configService = {
        get: jest.fn(),
    } as unknown as ConfigService;
    const usersService = {
        count: jest.fn(),
        find: jest.fn(),
    } as unknown as UsersService;
    const articlesService = {
        count: jest.fn(),
    } as unknown as ArticlesService;
    const blockedDomainsService = {
        findAll: jest.fn(),
        create: jest.fn(),
        deleteByDomain: jest.fn(),
    } as unknown as BlockedDomainsService;
    const jobQueueService = {
        getQueueStats: jest.fn(),
    } as unknown as JobQueueService;

    const controller = new AdminController(
        configService,
        usersService,
        articlesService,
        blockedDomainsService,
        jobQueueService,
    );

    const user = (clerkId: string, role?: string) => ({
        clerkId,
        publicMetadata: role ? { role } : {},
    }) as ClerkUserProfile;

    afterEach(() => jest.clearAllMocks());

    it('reports access for configured Clerk IDs', () => {
        jest.mocked(configService.get).mockReturnValue('other, admin_123');

        expect(controller.checkAccess(user('admin_123'))).toMatchObject({
            isAdmin: true,
            canSelectAiProvider: true,
            clerkId: 'admin_123',
        });
    });

    it('reports access for admin and moderator roles', () => {
        jest.mocked(configService.get).mockReturnValue(undefined);

        expect(controller.checkAccess(user('admin', 'admin')).isAdmin).toBe(true);
        expect(controller.checkAccess(user('moderator', 'moderator')).isAdmin).toBe(true);
        expect(controller.checkAccess(user('member', 'member')).isAdmin).toBe(false);
        expect(controller.checkAccess(user('admin', 'admin')).canSelectAiProvider).toBe(true);
        expect(controller.checkAccess(user('moderator', 'moderator')).canSelectAiProvider).toBe(false);
        expect(controller.checkAccess(user('member', 'member')).canSelectAiProvider).toBe(false);
    });

    it('blocks protected admin endpoints for regular users', () => {
        jest.mocked(configService.get).mockReturnValue(undefined);

        expect(() => controller.getBlockedDomains(user('member', 'member'))).toThrow(ForbiddenException);
    });

    it('returns the dashboard shape expected by the frontend', async () => {
        jest.mocked(configService.get).mockReturnValue('admin_123');
        jest.mocked(blockedDomainsService.findAll).mockResolvedValue([
            { id: '1', domain: 'spam.test', reason: 'spam' },
            { id: '2', domain: 'scam.test', reason: 'scam' },
            { id: '3', domain: 'spam-2.test', reason: 'spam' },
        ]);
        jest.mocked(usersService.count)
            .mockResolvedValueOnce(12)
            .mockResolvedValueOnce(3);
        jest.mocked(articlesService.count).mockResolvedValue(42);
        jest.mocked(jobQueueService.getQueueStats).mockResolvedValue({
            pro: { waiting: 1, active: 0, delayed: 0, failed: 0, completed: 2, paused: 0 },
            audio: { waiting: 0, active: 1, delayed: 0, failed: 0, completed: 1, paused: 0 },
            chunking: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 4, paused: 0 },
        });

        await expect(controller.getStats(user('admin_123'))).resolves.toMatchObject({
            blockedDomains: 3,
            blockedByReason: expect.arrayContaining([
                { reason: 'spam', count: 2 },
                { reason: 'scam', count: 1 },
            ]),
            users: { total: 12, pro: 3 },
            articles: { total: 42 },
        });
    });
});