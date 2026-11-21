import { isNonArticleFeedItem, isNonArticleUrl } from './feed-item-filter';

describe('feed-item-filter', () => {
    describe('isNonArticleUrl', () => {
        it('flags BBC podcast, audio, programme, and video URLs', () => {
            expect(isNonArticleUrl('https://www.bbc.co.uk/sounds/play/p0abc123')).toBe(true);
            expect(isNonArticleUrl('https://www.bbc.com/sounds/play/m001xyz')).toBe(true);
            expect(isNonArticleUrl('https://www.bbc.co.uk/programmes/p0abc123')).toBe(true);
            expect(isNonArticleUrl('https://www.bbc.com/audio/play/p0abc123')).toBe(true);
            expect(isNonArticleUrl('https://www.bbc.com/news/videos/c1234567890o')).toBe(true);
            expect(isNonArticleUrl('https://www.bbc.co.uk/news/av/world-123456')).toBe(true);
            expect(isNonArticleUrl('https://www.bbc.com/reel/video/p0xyz')).toBe(true);
        });

        it('flags general podcast and video URLs', () => {
            expect(isNonArticleUrl('https://www.nytimes.com/2026/05/01/podcasts/the-daily/episode.html')).toBe(true);
            expect(isNonArticleUrl('https://www.theguardian.com/news/audio/2026/may/01/today-in-focus')).toBe(true);
            expect(isNonArticleUrl('https://open.spotify.com/episode/abc123')).toBe(true);
            expect(isNonArticleUrl('https://example.com/media/show.mp3')).toBe(true);
        });

        it('allows written BBC and standard news articles', () => {
            expect(isNonArticleUrl('https://www.bbc.com/news/articles/c1234567890o')).toBe(false);
            expect(isNonArticleUrl('https://www.bbc.co.uk/news/world-europe-68123456')).toBe(false);
            expect(isNonArticleUrl('https://www.bbc.com/future/article/20260501-deep-sea')).toBe(false);
            expect(isNonArticleUrl('https://www.theguardian.com/technology/2026/may/01/ai-story')).toBe(false);
        });
    });

    describe('isNonArticleFeedItem', () => {
        it('flags items with audio/video enclosures or iTunes podcast metadata', () => {
            expect(
                isNonArticleFeedItem({
                    link: 'https://www.bbc.com/news/articles/c123',
                    enclosure: { url: 'https://open.live.bbc.co.uk/mediaselector/ep.mp3', type: 'audio/mpeg' },
                }),
            ).toBe(true);

            expect(
                isNonArticleFeedItem({
                    link: 'https://example.com/post',
                    itunes: { duration: '24:15' },
                }),
            ).toBe(true);
        });

        it('allows articles with image enclosures', () => {
            expect(
                isNonArticleFeedItem({
                    link: 'https://www.bbc.com/news/articles/c1234567890o',
                    enclosure: { url: 'https://ichef.bbci.co.uk/news/image.jpg', type: 'image/jpeg' },
                }),
            ).toBe(false);
        });
    });
});
