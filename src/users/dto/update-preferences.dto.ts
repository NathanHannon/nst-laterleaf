import { IsIn, IsOptional } from 'class-validator';

const THEMES = [
    'default',
    'cherry-blossom',
    'midnight-ocean',
    'forest-moss',
    'nord-arctic',
    'neon-nights',
    'dark-coffee',
    'berry-red',
    'wild-strawberry',
] as const;

export class UpdatePreferencesDto {
    @IsOptional()
    @IsIn(['light', 'dark', 'system'])
    appearance?: string;

    @IsOptional()
    @IsIn(THEMES)
    theme?: string;
}
