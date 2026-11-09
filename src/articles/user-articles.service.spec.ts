import { UserArticlesService } from './user-articles.service';

describe('UserArticlesService pasted semantic search', () => {
    it('limits pasted embedding search to the requesting user', async () => {
        const repository = {
            query: jest.fn().mockResolvedValue([]),
        };
        const service = new UserArticlesService(repository as never);

        await service.semanticSearchPasted([0.1, 0.2], 'user-a', 7);

        const [query, parameters] = repository.query.mock.calls[0];
        expect(query).toContain('WHERE user_id = $1');
        expect(query).toContain('pasted_embedding <=> $2::vector');
        expect(parameters).toEqual(['user-a', '[0.1,0.2]', 7]);
    });

    it('only saves pasted embeddings to the owning user entry', async () => {
        const repository = {
            query: jest.fn().mockResolvedValue(undefined),
        };
        const service = new UserArticlesService(repository as never);

        await service.savePastedEmbedding('entry-a', 'user-a', [0.3, 0.4]);

        const [query, parameters] = repository.query.mock.calls[0];
        expect(query).toContain('WHERE id = $2 AND user_id = $3');
        expect(parameters).toEqual(['[0.3,0.4]', 'entry-a', 'user-a']);
    });
});