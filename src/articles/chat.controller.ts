import {
    Body,
    Controller,
    ForbiddenException,
    Get,
    InternalServerErrorException,
    NotFoundException,
    Param,
    Post,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { ArticlesService } from './articles.service';
import { UserArticlesService } from './user-articles.service';
import { ArticleChunksService } from './article-chunks.service';
import { GenAiService } from '../genai/gen-ai.service';
import type { ChatMessage } from './entities/user-article.entity';

/**
 */
@UseGuards(ClerkAuthGuard)
@Controller('articles')
export class ChatController {
    constructor(
        private readonly usersService: UsersService,
        private readonly userArticlesService: UserArticlesService,
        private readonly articlesService: ArticlesService,
        private readonly articleChunksService: ArticleChunksService,
        private readonly genAiService: GenAiService,
    ) { }

    private async getAuthenticatedUser(
        currentUser: ClerkUserProfile,
    ): Promise<{ user: User; hasProAccess: boolean }> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('User not found.');
        }

        const publicMetadata = currentUser.publicMetadata || {};
        const hasProAccess = user.isPro || publicMetadata.role === 'admin';

        return { user, hasProAccess };
    }

    @Get(':id/chat')
    async getChatHistory(
        @Param('id') id: string,
        @CurrentUser() currentUser: ClerkUserProfile,
    ): Promise<{ chatHistory: ChatMessage[] }> {
        const { user } = await this.getAuthenticatedUser(currentUser);

        const userArticleLink = await this.userArticlesService.findByUserAndArticle(user.id, id);
        if (!userArticleLink) {
            throw new NotFoundException('Article not found');
        }

        const chatHistory = (userArticleLink.chatHistory || []).map((msg) => ({
            ...msg,
            timestamp: msg.timestamp || new Date().toISOString(),
        }));

        return { chatHistory };
    }

    @Post(':id/chat')
    async chatWithArticle(
        @Param('id') id: string,
        @Body() body: { message: string },
        @CurrentUser() currentUser: ClerkUserProfile,
    ): Promise<{ response: string; chatHistory: ChatMessage[] }> {
        const { user, hasProAccess } = await this.getAuthenticatedUser(currentUser);

        if (!hasProAccess) {
            throw new ForbiddenException('Chat with article is a Pro feature. Please upgrade to access it.');
        }

        const userArticleLink = await this.userArticlesService.findByUserAndArticle(user.id, id);
        if (!userArticleLink || !userArticleLink.articleId) {
            throw new NotFoundException('Article not found');
        }

        const article = await this.articlesService.findById(userArticleLink.articleId);
        if (!article) {
            throw new NotFoundException('Article not found');
        }

        const existingHistory = (userArticleLink.chatHistory || []).map((msg) => ({
            ...msg,
            timestamp: msg.timestamp || new Date().toISOString(),
        }));

        const userMessage: ChatMessage = {
            role: 'user',
            content: body.message,
            timestamp: new Date().toISOString(),
        };

        // Retrieve the most relevant chunks for the user's question via semantic search
        let chunkContext = '';
        try {
            const queryEmbedding = await this.genAiService.generateEmbeddings(body.message, {
                purpose: 'search_query',
            });
            if (queryEmbedding.length > 0) {
                const relevantChunks = await this.articleChunksService.findRelevantChunks(queryEmbedding, user.id, {
                    articleIds: [id],
                    limit: 3,
                });
                if (relevantChunks.length > 0) {
                    chunkContext = relevantChunks
                        .map((c, i) => `[Passage ${i + 1}]\n${c.chunkText.substring(0, 1500)}`)
                        .join('\n\n');
                }
            }
        } catch (e) {
            console.warn('⚠️ Chunk retrieval failed, falling back to truncated content:', e);
        }

        // Fallback: if no chunks available, use truncated article content
        const articleSummary = userArticleLink.summary ? `\nSummary: ${userArticleLink.summary}\n` : '';
        const articleContent = chunkContext
            ? `\nRelevant passages from the article:\n${chunkContext}`
            : `\n${(article.content || '').slice(0, userArticleLink.summary ? 4000 : 10000)}`;
        const articleContext = `Article: "${article.title}"\n${articleSummary}${articleContent}`;
        const recentHistory = existingHistory.slice(-20);
        const conversationHistory = recentHistory.map((msg) => `${msg.role}: ${msg.content}`).join('\n');

        const prompt = `You are a helpful AI assistant in a chat conversation about an article. The user is reading this article in their reading app and wants to discuss it with you.
Format your responses using Markdown (bold, lists, code blocks, etc.) for readability. Keep responses concise but informative.

${articleContext}

Previous conversation:
${conversationHistory}

User: ${body.message}`;

        try {
            const previousInteractionId = userArticleLink.chatInteractionId || undefined;

            const { response, interactionId } = await this.genAiService.generateChatMessage({
                message: body.message,
                fullContextPrompt: prompt,
                previousInteractionId,
            });

            if (!response) {
                throw new InternalServerErrorException('AI service returned empty response');
            }

            const assistantMessage: ChatMessage = {
                role: 'assistant',
                content: response,
                timestamp: new Date().toISOString(),
            };

            const updatedHistory = [...existingHistory, userMessage, assistantMessage];

            console.log('💬 Saving chat history to database:', {
                articleId: id,
                userId: user.id,
                messageCount: updatedHistory.length,
                interactionId,
            });

            await this.userArticlesService.updateById(userArticleLink.id, {
                chatHistory: updatedHistory,
                chatInteractionId: interactionId || undefined,
            });

            console.log('✅ Chat history saved successfully');

            return { response, chatHistory: updatedHistory };
        } catch (error) {
            console.log('Error in chat AI service:', error);
            throw new InternalServerErrorException('Failed to generate chat response');
        }
    }

    @Post(':id/chat/clear')
    async clearChatHistory(
        @Param('id') id: string,
        @CurrentUser() currentUser: ClerkUserProfile,
    ): Promise<{ success: boolean }> {
        const { user } = await this.getAuthenticatedUser(currentUser);

        const userArticleLink = await this.userArticlesService.findByUserAndArticle(user.id, id);
        if (!userArticleLink) {
            throw new NotFoundException('Article not found');
        }

        await this.userArticlesService.updateById(userArticleLink.id, {
            chatHistory: [],
            chatInteractionId: undefined,
        });

        return { success: true };
    }
}
