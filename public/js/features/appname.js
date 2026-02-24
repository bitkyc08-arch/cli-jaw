// ── Agent Name Customization ──
// localStorage-based agent display name (message label only)
// Logo, header, title remain "CLI-CLAW" (immutable)

const STORAGE_KEY = 'agentName';
const DEFAULT_NAME = 'CLI-CLAW';

let currentName = DEFAULT_NAME;

export function getAppName() {
    return currentName;
}

export function setAppName(name) {
    currentName = (name || '').trim() || DEFAULT_NAME;
    localStorage.setItem(STORAGE_KEY, currentName);
    // Update input field
    const input = document.getElementById('appNameInput');
    if (input) input.value = currentName;
}

export function initAppName() {
    currentName = localStorage.getItem(STORAGE_KEY) || DEFAULT_NAME;

    // Sync input
    const input = document.getElementById('appNameInput');
    if (input) input.value = currentName;

    // Save button
    document.getElementById('appNameSave')?.addEventListener('click', () => {
        const inp = document.getElementById('appNameInput');
        if (inp) setAppName(inp.value);
    });

    // Enter key
    document.getElementById('appNameInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            setAppName(e.target.value);
            e.target.blur();
        }
    });
}
