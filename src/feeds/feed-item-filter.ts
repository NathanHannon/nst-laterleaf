interface FeedItemLike {
    link?: string;
    enclosure?: {
        url?: string;
        type?: string;
    };
    itunes?: {
        duration?: string;
        episode?: string;
        episodeType?: string;
    };
}

const NON_ARTICLE_HOSTS = new Set([
    'podcasts.apple.com',
    'soundcloud.com',
    'youtube.com',
    'youtu.be',
    'vimeo.com',
]);

/**
 * URL path prefixes/segments that represent audio, podcasts, radio programmes,
 * or video clips rather than readable written articles (including BBC Sounds,
 * BBC Programmes, BBC iPlayer, BBC News AV/Videos/Audio, and general podcast paths).
 */
const NON_ARTICLE_PATH_PATTERNS: RegExp[] = [
    /^\/sounds(\/|$)/i,
    /^\/programmes(\/|$)/i,
    /^\/iplayer(\/|$)/i,
    /^\/reel(\/|$)/i,
    /^\/audio(\/|$)/i,
    /^\/news\/av(\/|$)/i,
    /^\/news\/videos?(\/|$)/i,
    /^\/news\/audio(\/|$)/i,
    /\/podcasts?(\/|$)/i,
    /\/episodes?(\/|$)/i,
    /\/videos?(\/|$)/i,
];

const MEDIA_FILE_EXTENSION = /\.(mp3|m4a|wav|ogg|aac|flac|opus|mp4|mov|webm)(\?|$)/i;

/**
 * Returns true when a URL points to a podcast episode, audio stream, radio
 * programme, or video page rather than a written article.
 */
export function isNonArticleUrl(rawUrl?: string | null): boolean {
    if (!rawUrl) return false;
    try {
        const parsed = new URL(rawUrl);
        const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

        if (NON_ARTICLE_HOSTS.has(host)) {
            return true;
        }
        if (host === 'open.spotify.com' && /^\/(episode|show)(\/|$)/i.test(parsed.pathname)) {
            return true;
        }
        if (MEDIA_FILE_EXTENSION.test(parsed.pathname)) {
            return true;
        }
        return NON_ARTICLE_PATH_PATTERNS.some((pattern) => pattern.test(parsed.pathname));
    } catch {
        return false;
    }
}

/**
 * Returns true when an RSS feed item is a podcast/audio/video item rather than
 * a written article (checked via RSS enclosures, iTunes podcast metadata, and URL).
 */
export function isNonArticleFeedItem(item: FeedItemLike): boolean {
    const enclosureType = item.enclosure?.type?.toLowerCase();
    if (enclosureType && (enclosureType.startsWith('audio/') || enclosureType.startsWith('video/'))) {
        return true;
    }

    if (item.enclosure?.url && MEDIA_FILE_EXTENSION.test(item.enclosure.url)) {
        return true;
    }

    if (item.itunes && (item.itunes.duration || item.itunes.episode || item.itunes.episodeType)) {
        return true;
    }

    return isNonArticleUrl(item.link);
}
