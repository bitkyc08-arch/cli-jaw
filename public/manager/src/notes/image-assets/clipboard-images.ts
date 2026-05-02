const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const EXTENSION_BY_MIME: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

function isAllowedImage(file: File | null): file is File {
    return Boolean(file && ALLOWED_IMAGE_TYPES.has(file.type));
}

function namedClipboardFile(file: File): File {
    if (file.name) return file;
    const extension = EXTENSION_BY_MIME[file.type] ?? 'png';
    return new File([file], `pasted-image.${extension}`, {
        type: file.type,
        lastModified: file.lastModified,
    });
}

export function firstClipboardImage(data: DataTransfer | null): File | null {
    if (!data) return null;
    for (const item of Array.from(data.items ?? [])) {
        if (item.kind !== 'file' || !ALLOWED_IMAGE_TYPES.has(item.type)) continue;
        const file = item.getAsFile();
        if (isAllowedImage(file)) return namedClipboardFile(file);
    }
    for (const file of Array.from(data.files ?? [])) {
        if (isAllowedImage(file)) return namedClipboardFile(file);
    }
    return null;
}
