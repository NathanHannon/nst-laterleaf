import { Module } from '@nestjs/common';
import { MetadataScrapingService } from './metadata-scraping.service';
import { ContentExtractionService } from './content-extraction.service';
import { RobotsTxtService } from './robots-txt.service';

@Module({
    providers: [RobotsTxtService, MetadataScrapingService, ContentExtractionService],
    exports: [RobotsTxtService, MetadataScrapingService, ContentExtractionService],
})
export class ContentExtractionModule { }
