import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlockedDomain } from './entities/blocked-domain.entity';
import { BlockedDomainsService } from './blocked-domains.service';
import { ContentModerationService } from './content-moderation.service';

@Module({
    imports: [TypeOrmModule.forFeature([BlockedDomain])],
    providers: [BlockedDomainsService, ContentModerationService],
    exports: [BlockedDomainsService, ContentModerationService],
})
export class ContentModerationModule { }
