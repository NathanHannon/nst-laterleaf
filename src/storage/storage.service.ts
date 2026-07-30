import { Injectable } from '@nestjs/common';
import AWS from 'aws-sdk';
import crypto from 'crypto';

/**
 * audio upload/retrieval. Injectable() (request-scoped equivalent of LB's TRANSIENT
 * not needed here since it's stateless besides the S3 client, so DEFAULT scope is fine).
 */
@Injectable()
export class StorageService {
    private s3: AWS.S3;
    private publicUrl: string;

    constructor() {
        if (
            !process.env.CF_ACCOUNT_ID ||
            !process.env.CF_R2_BUCKET_NAME ||
            !process.env.CF_R2_ACCESS_KEY_ID ||
            !process.env.CF_R2_SECRET_ACCESS_KEY ||
            !process.env.CF_PUBLIC_URL
        ) {
            throw new Error('Cloudflare R2 environment variables are not configured.');
        }

        this.s3 = new AWS.S3({
            endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            accessKeyId: process.env.CF_R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.CF_R2_SECRET_ACCESS_KEY,
            signatureVersion: 'v4',
            s3ForcePathStyle: false,
        });

        this.publicUrl = process.env.CF_PUBLIC_URL;
    }

    private formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    /**
     * Uploads audio buffer to Cloudflare R2 and returns the public URL
     */
    async uploadAudio(
        articleId: string,
        audioBuffer: Buffer,
        userId: string,
        type: 'podcast' | 'single',
        options?: {
            format?: string;
            mimeType?: string;
            voice?: string;
            speed?: number;
        },
    ): Promise<string> {
        const { format = 'mp3', mimeType = 'audio/mpeg' } = options || {};

        let key: string;
        if (type === 'single') {
            const voice = options?.voice || 'Puck';
            const speed = options?.speed || 1.0;
            key = `tts/${userId}/${articleId}_${voice}_${speed}.${format}`;
        } else {
            const hash = crypto.createHash('md5').update(audioBuffer).digest('hex').substring(0, 8);
            key = `podcasts/${userId}/${articleId}_podcast-${hash}.${format}`;
        }

        console.log(`📤 Uploading ${type} audio (${format}) to R2:`);
        console.log(`   📁 Key: ${key}`);
        console.log(`   📄 MIME type: ${mimeType}`);
        console.log(`   📦 Size: ${this.formatBytes(audioBuffer.length)}`);

        try {
            await this.s3
                .upload({
                    Bucket: process.env.CF_R2_BUCKET_NAME!,
                    Key: key,
                    Body: audioBuffer,
                    ContentType: mimeType,
                    ACL: 'public-read',
                })
                .promise();

            const fileUrl = `${this.publicUrl}/${key}`;
            console.log(`✅ Audio uploaded. Public URL: ${fileUrl}`);
            return fileUrl;
        } catch (error) {
            console.error('❌ Failed to upload audio to R2:', error);
            throw new Error('Audio upload failed');
        }
    }

    /**
     * Retrieves a readable stream for an object from R2 given its public URL or key.
     */
    async getAudioStream(location: string): Promise<NodeJS.ReadableStream> {
        let key = location;

        if (location.startsWith(this.publicUrl)) {
            key = location.replace(this.publicUrl + '/', '');
        }
        key = key.replace(/^\/+/, '');

        console.log(`📥 Streaming audio from R2. Key: ${key}`);

        const params = {
            Bucket: process.env.CF_R2_BUCKET_NAME!,
            Key: key,
        };

        return this.s3.getObject(params).createReadStream();
    }

    /**
     * @deprecated Use uploadAudio instead
     */
    async uploadPodcastAudio(
        articleId: string,
        audioBuffer: Buffer,
        userId: string,
        options?: {
            format?: string;
            mimeType?: string;
        },
    ): Promise<string> {
        return this.uploadAudio(articleId, audioBuffer, userId, 'podcast', options);
    }

    /**
     * Checks if audio already exists for this article/user combination.
     * Returns public URL if found, null otherwise.
     */
    async checkAudioExists(
        articleId: string,
        userId: string,
        type: 'podcast' | 'single',
        options?: {
            voice?: string;
            speed?: number;
        },
    ): Promise<string | null> {
        try {
            let prefix: string;
            if (type === 'single') {
                const voice = options?.voice || 'Puck';
                const speed = options?.speed || 1.0;
                prefix = `tts/${userId}/${articleId}_${voice}_${speed}`;
            } else {
                prefix = `podcasts/${userId}/${articleId}_podcast-`;
            }

            const legacyPrefix = `podcasts/${userId}/${articleId}-`;

            const objects = await this.s3
                .listObjectsV2({
                    Bucket: process.env.CF_R2_BUCKET_NAME!,
                    Prefix: prefix,
                    MaxKeys: 1,
                })
                .promise();

            if (objects.Contents && objects.Contents.length > 0) {
                const key = objects.Contents[0].Key!;
                const fileUrl = `${this.publicUrl}/${key}`;
                console.log(`✅ Found existing ${type} audio in R2. Public URL: ${fileUrl}`);
                return fileUrl;
            }

            if (type === 'podcast') {
                const legacyObjects = await this.s3
                    .listObjectsV2({
                        Bucket: process.env.CF_R2_BUCKET_NAME!,
                        Prefix: legacyPrefix,
                        MaxKeys: 1,
                    })
                    .promise();

                if (legacyObjects.Contents && legacyObjects.Contents.length > 0) {
                    const key = legacyObjects.Contents[0].Key!;
                    const fileUrl = `${this.publicUrl}/${key}`;
                    console.log(`✅ Found existing legacy podcast audio in R2. Public URL: ${fileUrl}`);
                    return fileUrl;
                }
            }

            return null;
        } catch (error) {
            console.error(`❌ Failed to check existing ${type} audio in R2:`, error);
            return null;
        }
    }

    /**
     * Checks if podcast audio already exists for this article/user combination
     * Returns public URL if found, null otherwise
     * @deprecated Use checkAudioExists instead
     */
    async checkPodcastExists(articleId: string, userId: string): Promise<string | null> {
        return this.checkAudioExists(articleId, userId, 'podcast');
    }

    /**
     * Deletes podcast audio from R2 storage
     */
    async deletePodcastAudio(audioUrl: string): Promise<void> {
        try {
            const url = new URL(audioUrl);
            const key = url.pathname.substring(1);

            console.log(`🗑️ Deleting from R2. Original URL: ${audioUrl}`);
            console.log(`🗑️ Extracted key: ${key}`);
            console.log(`🗑️ Bucket: ${process.env.CF_R2_BUCKET_NAME}`);

            await this.s3
                .deleteObject({
                    Bucket: process.env.CF_R2_BUCKET_NAME!,
                    Key: key,
                })
                .promise();

            console.log(`✅ Successfully deleted R2 object: ${key}`);
        } catch (error) {
            console.error('❌ Failed to delete audio from R2:', error);
            throw new Error('Audio deletion failed');
        }
    }
}
