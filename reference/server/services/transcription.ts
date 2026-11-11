import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import os from 'os';

/**
 * Transcribe audio buffer to text using gpt-transcribe,
 * then clean up the transcription with GPT-4o-mini.
 * Output is always English (see extra/chat-ux.md).
 */
export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OpenAI API key not configured. Please set OPENAI_API_KEY in server environment.',
    );
  }

  // Convert audio to mp3 format
  // @ts-expect-error - fluent-ffmpeg has no published type definitions
  const ffmpeg = (await import('fluent-ffmpeg')).default;
  const ffmpegPath = (await import('ffmpeg-static')).default as unknown as string;

  ffmpeg.setFfmpegPath(ffmpegPath);

  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `input_${Date.now()}.webm`);
  const outputPath = path.join(tmpDir, `output_${Date.now()}.mp3`);

  // Write input buffer to temp file
  await fs.writeFile(inputPath, audioBuffer);

  // Convert to mp3
  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat('mp3')
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputPath);
  });

  const OpenAI = (await import('openai')).default;
  const openai = new OpenAI({ apiKey });

  // gpt-transcribe takes a `languages` list instead of `language`; the SDK
  // types don't know it yet, so it goes through the request-body override.
  // Without the hint and prompt the model can drift into another language.
  const request = {
    file: createReadStream(outputPath),
    model: 'gpt-transcribe',
    prompt:
      'An English voice dictation about software development: coding tasks, bugs, features and project planning.',
  };
  const transcription = await openai.audio.transcriptions.create(request, {
    body: { ...request, languages: ['en'] },
  });

  // Clean up temp files
  await fs.unlink(inputPath).catch(() => {});
  await fs.unlink(outputPath).catch(() => {});

  let transcribedText = transcription.text || '';

  // If no transcribed text, return empty
  if (!transcribedText) {
    return '';
  }

  // Clean up the transcription
  transcribedText = await cleanupTranscription(openai as unknown as OpenAIChatClient, transcribedText);

  return transcribedText;
}

/**
 * Clean up a raw transcription to fix grammar, filler words, etc.
 * while preserving the user's exact intent.
 */
type OpenAIChatClient = {
  chat: {
    completions: {
      create: (args: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        temperature: number;
        max_tokens: number;
      }) => Promise<{ choices: Array<{ message: { content: string | null } }> }>;
    };
  };
};

async function cleanupTranscription(
  openai: OpenAIChatClient,
  rawText: string,
): Promise<string> {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a transcription cleaner. Your ONLY job is to output a clean, polished version of the user\'s spoken message in English. Do NOT answer questions, provide information, or interpret the content.',
        },
        {
          role: 'user',
          content: `You are cleaning up a voice-to-text transcription. Your task is to:

1. TRANSCRIBE: Output ONLY what the user said, cleaned up
2. CLARIFY: Fix grammar, filler words (um, uh), and incomplete sentences
3. PRESERVE: Keep the user's exact intent, meaning, and tone
4. ENGLISH: The user always speaks English. If the transcription is in another language, translate it to English

CRITICAL RULES:
- Output ONLY the cleaned message, nothing else
- The output MUST be in English
- Do NOT answer questions the user asks
- Do NOT provide information or explanations
- Do NOT add your own words, context, or instructions
- Do NOT change the meaning or expand on ideas
- If the user asks "What is the weather in Paris?", output exactly: "What is the weather in Paris?"

Raw transcription to clean:
"${rawText}"

Cleaned message:`,
        },
      ],
      temperature: 0.3,
      max_tokens: 800,
    });

    const cleaned = completion.choices[0]?.message.content ?? rawText;
    // Strip surrounding quotes that the LLM sometimes adds
    return cleaned.replace(/^["']|["']$/g, '');
  } catch (error) {
    console.error('Transcription cleanup error:', error);
    // Fall back to raw transcription if cleanup fails
    return rawText;
  }
}
