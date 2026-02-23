// ── Render Helpers ──

export function escapeHtml(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderMarkdown(text) {
    // Strip orchestration JSON blocks (subtasks) from display
    let cleaned = text.replace(/```json\n[\s\S]*?\n```/g, '');  // fenced
    cleaned = cleaned.replace(/\{[\s\S]*"subtasks"\s*:\s*\[[\s\S]*?\]\s*\}/g, '').trim();  // raw
    if (!cleaned) return '<em style="color:var(--text-dim)">🎯 작업 분배 중...</em>';
    return escapeHtml(cleaned)
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        .replace(/`([^`]+)`/g, '<code style="background:var(--border);padding:1px 4px;border-radius:3px">$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/^### (.+)$/gm, '<div style="font-weight:700;margin:8px 0 4px">$1</div>')
        .replace(/^## (.+)$/gm, '<div style="font-weight:700;font-size:14px;margin:10px 0 4px">$1</div>')
        .replace(/^# (.+)$/gm, '<div style="font-weight:700;font-size:16px;margin:12px 0 4px">$1</div>')
        .replace(/\n/g, '<br>');
}
