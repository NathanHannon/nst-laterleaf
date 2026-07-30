import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * junction table between UserArticle and Tag. `id` is generated in
 * application code (see TagsService), matching the original model.
 */
@Entity({ name: 'user_article_tags' })
export class UserArticleTag {
    @PrimaryColumn('uuid')
    id: string;

    @Column({ name: 'user_article_id' })
    userArticleId: string;

    @Column({ name: 'tag_id' })
    tagId: string;
}
