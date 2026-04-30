import { mkdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import trash from 'trash';

export async function moveToSystemTrash(paths: string[]): Promise<void> {
    if (process.env.NODE_ENV === 'test' && process.env.CLI_JAW_TEST_SYSTEM_TRASH_DIR) {
        if (process.env.CLI_JAW_TEST_SYSTEM_TRASH_FAIL === '1') {
            throw new Error('Simulated system trash failure');
        }
        const targetDir = process.env.CLI_JAW_TEST_SYSTEM_TRASH_DIR;
        await mkdir(targetDir, { recursive: true });
        const prefix = `${Date.now()}_`;
        for (const path of paths) {
            await rename(path, join(targetDir, `${prefix}${basename(path)}`));
        }
        return;
    }

    await trash(paths, { glob: false });
}
