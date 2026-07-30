import { Injectable } from '@nestjs/common';

/**
 * Ports lb-laterleaf/src/services/audio-processing.service.ts.
 * Stateless helper for splitting podcast scripts into TTS-safe chunks and
 * converting/detecting raw PCM audio via FFmpeg.
 */
@Injectable()
export class AudioProcessingService {
    /**
     * Splits a podcast script into chunks at intelligent speaker boundaries to prevent audio degradation.
     * When a chunk reaches token limit, looks back to find the last "Speaker 1:" line and breaks after it.
     * This ensures Speaker 2 always starts fresh with clear voice quality (not degraded from long synthesis).
     * Both speakers remain in most chunks for conversational context.
     */
    public splitScriptIntoChunks(script: string, maxTokensPerChunk: number = 1500): string[] {
        const lines = script.split('\n').filter((line) => line.trim());
        const chunks: string[] = [];
        let currentChunk: string[] = [];
        let currentTokens = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineTokens = this.estimateTokens(line);

            // If adding this line exceeds the limit and we already have content, intelligently split
            if (currentTokens + lineTokens > maxTokensPerChunk && currentChunk.length > 0) {
                // Smart boundary: Find the last "Speaker 1:" line to split after it
                // This ensures Speaker 2 always starts fresh at chunk boundary with no voice degradation
                let splitIndex = currentChunk.length - 1;

                // Look backwards for the last Speaker 1 line (prefer splitting here)
                for (let j = currentChunk.length - 1; j >= 0; j--) {
                    if (currentChunk[j].startsWith('Speaker 1:')) {
                        splitIndex = j;
                        break;
                    }
                }

                // Save chunk up to and including the Speaker 1 line
                const chunkToSave = currentChunk.slice(0, splitIndex + 1).join('\n');
                if (chunkToSave.trim()) {
                    chunks.push(chunkToSave);
                    console.log(`✂️ Chunk boundary: split after Speaker 1 (${this.estimateTokens(chunkToSave)} tokens)`);
                }

                // Start new chunk with remaining lines (Speaker 2's response gets fresh start)
                currentChunk = currentChunk.slice(splitIndex + 1);
                currentTokens = this.estimateTokens(currentChunk.join('\n'));
            }

            currentChunk.push(line);
            currentTokens += lineTokens;
        }

        if (currentChunk.length > 0) {
            chunks.push(currentChunk.join('\n'));
        }

        return chunks;
    }

    /**
     * Estimates the number of tokens in a given text string.
     * Rough estimation: 1 word ≈ 1.3 tokens (Gemini/standard tokenizer).
     */
    private estimateTokens(text: string): number {
        const words = text.trim().split(/\s+/).length;
        return Math.ceil(words * 1.3);
    }

    /**
     * Parses PCM parameters from MIME type string
     */
    public parsePCMParams(mimeType: string): {
        sampleRate: number;
        bitDepth: number;
        channels: number;
    } {
        // Default PCM parameters
        const defaultParams = {
            sampleRate: 24000,
            bitDepth: 16,
            channels: 1,
        };

        try {
            // Parse MIME type like "audio/L16;codec=pcm;rate=24000"
            const parts = mimeType.toLowerCase().split(';');
            const params: any = { ...defaultParams };

            for (const part of parts) {
                const [key, value] = part.trim().split('=');
                if (key === 'rate') {
                    params.sampleRate = parseInt(value, 10) || defaultParams.sampleRate;
                }
                // L16 indicates 16-bit linear PCM
                if (part.includes('l16')) {
                    params.bitDepth = 16;
                }
            }

            return params;
        } catch (error) {
            console.warn('Failed to parse PCM parameters, using defaults:', error);
            return defaultParams;
        }
    }

    /**
     * Converts raw PCM audio buffer to specified format (MP3/AAC) using FFmpeg
     */
    public async convertPCMToFormat(
        pcmBuffer: Buffer,
        params: { sampleRate: number; bitDepth: number; channels: number },
        format: 'mp3' | 'm4a' = 'mp3',
    ): Promise<Buffer> {
        try {
            const ffmpegPath = require('ffmpeg-static');
            const { spawn } = require('child_process');
            const path = require('path');
            const fs = require('fs').promises;

            console.log(`🔧 PCM conversion parameters:`, params);
            console.log(`   📊 Input size: ${pcmBuffer.length} bytes`);
            console.log(`   🎯 Target format: ${format}`);

            // Create temporary files
            const tempDir = require('os').tmpdir();
            const inputFile = path.join(tempDir, `pcm_${Date.now()}.raw`);
            const outputFile = path.join(tempDir, `audio_${Date.now()}.${format}`);

            try {
                // Write PCM data to temporary file
                await fs.writeFile(inputFile, pcmBuffer);

                // Determine codec based on format
                const codec = format === 'm4a' ? 'aac' : 'mp3';

                // FFmpeg command to convert raw PCM to target format
                const ffmpegArgs = [
                    '-f', 's16le',                       // Input format: 16-bit little-endian PCM
                    '-ar', params.sampleRate.toString(),  // Sample rate
                    '-ac', params.channels.toString(),    // Number of channels
                    '-i', inputFile,                      // Input file
                    '-codec:a', codec,                    // Audio codec
                    '-b:a', '128k',                       // Bitrate
                    '-movflags', '+faststart',            // Optimize for web streaming
                    '-y',                                 // Overwrite output file
                    outputFile,                           // Output file
                ];

                console.log(`   🔄 Running FFmpeg: ${ffmpegArgs.join(' ')}`);

                return await new Promise((resolve, reject) => {
                    const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
                        stdio: ['pipe', 'pipe', 'pipe'],
                    });

                    let stderr = '';

                    ffmpeg.stderr.on('data', (data: Buffer) => {
                        stderr += data.toString();
                    });

                    ffmpeg.on('close', async (code: number) => {
                        try {
                            if (code !== 0) {
                                throw new Error(`FFmpeg exited with code ${code}: ${stderr}`);
                            }

                            // Read the converted file
                            const outputBuffer = await fs.readFile(outputFile);

                            console.log(`   ✅ Conversion complete:`);
                            console.log(`      📊 Output size: ${outputBuffer.length} bytes`);
                            console.log(`      📈 Compression ratio: ${(pcmBuffer.length / outputBuffer.length).toFixed(2)}x`);

                            // Clean up temporary files
                            try {
                                await fs.unlink(inputFile);
                                await fs.unlink(outputFile);
                            } catch (cleanupError) {
                                console.warn('Warning: Failed to clean up temp files:', cleanupError);
                            }

                            resolve(outputBuffer);
                        } catch (error) {
                            reject(error);
                        }
                    });

                    ffmpeg.on('error', (error: Error) => {
                        reject(new Error(`FFmpeg process error: ${error.message}`));
                    });
                });
            } catch (error) {
                // Clean up temp files in case of error
                try {
                    await fs.unlink(inputFile).catch(() => { });
                    await fs.unlink(outputFile).catch(() => { });
                } catch { }
                throw error;
            }
        } catch (error) {
            console.error(`❌ PCM to ${format} conversion failed:`, error);
            throw new Error(`Failed to convert PCM to ${format}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Detects audio format by examining magic numbers in the buffer
     */
    public detectAudioFormat(buffer: Buffer): string {
        if (buffer.length < 16) return 'unknown';

        // Check magic numbers for common audio formats
        const header = buffer.slice(0, 16);

        // MP3 - starts with ID3 tag or MPEG frame sync
        if (
            header.slice(0, 3).equals(Buffer.from('ID3')) ||
            (header[0] === 0xff && (header[1] & 0xe0) === 0xe0)
        ) {
            return 'mp3';
        }

        // WAV - starts with RIFF....WAVE
        if (
            header.slice(0, 4).equals(Buffer.from('RIFF')) &&
            header.slice(8, 12).equals(Buffer.from('WAVE'))
        ) {
            return 'wav';
        }

        // FLAC - starts with fLaC
        if (header.slice(0, 4).equals(Buffer.from('fLaC'))) {
            return 'flac';
        }

        // OGG - starts with OggS
        if (header.slice(0, 4).equals(Buffer.from('OggS'))) {
            return 'ogg';
        }

        // AAC - starts with specific patterns
        if (
            (header[0] === 0xff && (header[1] & 0xf6) === 0xf0) ||
            header.slice(4, 8).equals(Buffer.from('ftyp'))
        ) {
            return 'aac';
        }

        return 'unknown';
    }

    /**
     * Returns the appropriate MIME type for an audio format
     */
    public getMimeTypeForFormat(format: string): string {
        const mimeTypes: Record<string, string> = {
            mp3: 'audio/mpeg',
            wav: 'audio/wav',
            flac: 'audio/flac',
            ogg: 'audio/ogg',
            aac: 'audio/aac',
            m4a: 'audio/mp4',
            unknown: 'audio/mpeg', // Default to MP3
        };

        return mimeTypes[format] || 'audio/mpeg';
    }
}
