import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateBlockedDomainDto {
    @IsString()
    @MinLength(1)
    @MaxLength(253)
    domain: string;

    @IsIn(['spam', 'malicious', 'inappropriate', 'scam', 'phishing'])
    reason: string;

    @IsOptional()
    @IsString()
    @MaxLength(1000)
    notes?: string;
}