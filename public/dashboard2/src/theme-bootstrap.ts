try {
    const saved = localStorage.getItem('jaw.uiTheme');
    const theme = saved === 'dark' || saved === 'light' || saved === 'auto'
        ? saved
        : 'auto';
    document.documentElement.setAttribute('data-theme', theme);
} catch {
    document.documentElement.setAttribute('data-theme', 'auto');
}
