import { describe, it, expect, vi, afterEach } from 'vitest';

const { transcriptionsCreate, chatCreate } = vi.hoisted(() => ({
    transcriptionsCreate: vi.fn(),
    chatCreate: vi.fn(),
}));

// Mock dependencies before importing the module
vi.mock('fluent-ffmpeg', () => {
    // Chainable ffmpeg(input).toFormat().on('end').on('error').save() that
    // fires 'end' as soon as save() is called.
    const ffmpeg = Object.assign(
        vi.fn(() => {
            const handlers: Record<string, () => void> = {};
            const chain = {
                toFormat: () => chain,
                on: (event: string, cb: () => void) => {
                    handlers[event] = cb;
                    return chain;
                },
                save: () => handlers.end?.(),
            };
            return chain;
        }),
        { setFfmpegPath: vi.fn() },
    );
    return { default: ffmpeg };
});
vi.mock('ffmpeg-static', () => ({ default: '/usr/bin/ffmpeg' }));
vi.mock('openai', () => ({
    default: vi.fn(function () {
        return {
            audio: { transcriptions: { create: transcriptionsCreate } },
            chat: { completions: { create: chatCreate } },
        };
    }),
}));
vi.mock('fs/promises', () => ({
    default: {
        writeFile: vi.fn().mockResolvedValue(undefined),
        unlink: vi.fn().mockResolvedValue(undefined),
    },
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('fs', () => {
    const createReadStream = vi.fn().mockReturnValue('mock-stream');
    return { default: { createReadStream }, createReadStream };
});

describe('Transcription Service', () => {
    describe('transcribeAudio', () => {
        afterEach(() => {
            vi.unstubAllEnvs();
            transcriptionsCreate.mockReset();
            chatCreate.mockReset();
        });

        it('transcribes with gpt-transcribe, pinned to English', async () => {
            vi.stubEnv('OPENAI_API_KEY', 'sk-test');
            transcriptionsCreate.mockResolvedValue({ text: 'um fix the bug' });
            chatCreate.mockResolvedValue({ choices: [{ message: { content: 'Fix the bug.' } }] });
            const { transcribeAudio } = await import('./transcription');

            const text = await transcribeAudio(Buffer.from('audio'));

            expect(text).toBe('Fix the bug.');
            const [request, options] = transcriptionsCreate.mock.calls[0]!;
            expect(request).toMatchObject({ model: 'gpt-transcribe', prompt: expect.stringContaining('English') });
            expect(request).not.toHaveProperty('language');
            expect(options.body).toMatchObject({ model: 'gpt-transcribe', file: 'mock-stream', languages: ['en'] });
        });

        it('tells the cleanup pass to output English', async () => {
            vi.stubEnv('OPENAI_API_KEY', 'sk-test');
            transcriptionsCreate.mockResolvedValue({ text: 'Почини баг' });
            chatCreate.mockResolvedValue({ choices: [{ message: { content: 'Fix the bug.' } }] });
            const { transcribeAudio } = await import('./transcription');

            await transcribeAudio(Buffer.from('audio'));

            const { messages } = chatCreate.mock.calls[0]![0];
            expect(messages[0].content).toContain('in English');
            expect(messages[1].content).toContain('The output MUST be in English');
        });

        it('throws when OPENAI_API_KEY is not set', async () => {
            vi.stubEnv('OPENAI_API_KEY', '');
            const { transcribeAudio } = await import('./transcription');

            await expect(transcribeAudio(Buffer.from('audio'))).rejects.toThrow('OpenAI API key not configured');
            expect(transcriptionsCreate).not.toHaveBeenCalled();
        });
    });

    describe('Quote stripping from cleanup response', () => {
        // Test the quote-stripping logic directly
        function stripQuotes(text: string) {
            return text.replace(/^["']|["']$/g, '');
        }

        it('should strip surrounding double quotes', () => {
            expect(stripQuotes('"Does the /projects/:id endpoint accept a name parameter?"'))
                .toBe('Does the /projects/:id endpoint accept a name parameter?');
        });

        it('should strip surrounding single quotes', () => {
            expect(stripQuotes("'Hello world'"))
                .toBe('Hello world');
        });

        it('should not strip quotes in the middle of text', () => {
            expect(stripQuotes('He said "hello" to me'))
                .toBe('He said "hello" to me');
        });

        it('should handle text without quotes', () => {
            expect(stripQuotes('Just a normal message'))
                .toBe('Just a normal message');
        });

        it('should handle empty string', () => {
            expect(stripQuotes('')).toBe('');
        });

        it('should strip only leading double quote', () => {
            expect(stripQuotes('"Hello world'))
                .toBe('Hello world');
        });

        it('should strip only trailing double quote', () => {
            expect(stripQuotes('Hello world"'))
                .toBe('Hello world');
        });

        it('should strip mismatched quotes', () => {
            expect(stripQuotes('"Hello world\''))
                .toBe('Hello world');
        });
    });
});
