/**
 * src/telegram/voice.ts — Voice message handler
 * Separated from bot.ts to comply with 500-line rule.
 * Downloads Telegram voice → STT → forwards text to tgOrchestrate.
 */
import type { Context } from 'grammy';
import { settings } from '../core/config.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { t } from '../core/i18n.js';
import { saveUpload } from '../agent/spawn.js';
import { downloadTelegramFile, TELEGRAM_DOWNLOAD_LIMITS } from '../../lib/upload.js';
import { transcribeVoice } from '../../lib/stt.js';

export async function handleVoice(
    ctx: Context,
    currentLocale: () => string,
    tgOrchestrate: (ctx: Context, prompt: string, display: string) => Promise<void>,
): Promise<void> {
    const voice = ctx.message!.voice!;
    console.log(`[tg:voice] ${ctx.chat!.id}: ${voice.duration}s, ${voice.file_size} bytes`);
    try {
        const dlResult = await downloadTelegramFile(voice.file_id, settings["telegram"].token, stripUndefined({
            kind: 'voice',
            maxBytes: TELEGRAM_DOWNLOAD_LIMITS.voice,
            fileSize: voice.file_size,
        })) as Record<string, any>;
        const filePath = saveUpload(dlResult["buffer"], `voice${dlResult["ext"] || '.ogg'}`);

        const stt = await transcribeVoice(filePath, 'audio/ogg');
        console.log(`[tg:voice] STT (${stt.engine}): ${stt.elapsed.toFixed(1)}s → "${stt.text.slice(0, 60)}"`);

        if (!stt.text.trim()) {
            await ctx.reply(t('tg.voiceEmpty', {}, currentLocale()));
            return;
        }
        await tgOrchestrate(ctx, stt.text, `🎤 ${stt.text.slice(0, 80)}`);
    } catch (err: unknown) {
        console.error('[tg:voice:error]', err);
        await ctx.reply(t('tg.voiceFail', { msg: (err as Error).message }, currentLocale()));
    }
}
