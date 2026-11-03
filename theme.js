(() => {
  const presets = {
    violet: { accent: '#7c3aed', accentStrong: '#6d28d9', tint: '#f5f3ff', surface: '#ffffff', background: '#f7f5ff', text: '#242132', muted: '#6b6680' },
    forest: { accent: '#15803d', accentStrong: '#166534', tint: '#ecfdf3', surface: '#ffffff', background: '#f3faf5', text: '#17251b', muted: '#657568' },
    sunset: { accent: '#ea580c', accentStrong: '#c2410c', tint: '#fff7ed', surface: '#ffffff', background: '#fff8f3', text: '#30221c', muted: '#7e6659' },
    ocean: { accent: '#0284c7', accentStrong: '#0369a1', tint: '#f0f9ff', surface: '#ffffff', background: '#f2faff', text: '#172630', muted: '#607583' },
    mono: { accent: '#334155', accentStrong: '#1e293b', tint: '#f1f5f9', surface: '#ffffff', background: '#f8fafc', text: '#1e293b', muted: '#64748b' }
  };
  function apply(settings = {}) {
    const dark = settings.themeMode === 'dark' || (settings.themeMode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    const base = settings.themePreset === 'custom' ? settings.customTheme : presets[settings.themePreset] || presets.violet;
    const theme = dark ? { ...base, surface: '#17151f', background: '#100f16', text: '#f4f1ff', muted: '#b8b1c8', tint: '#251f35' } : base;
    const root = document.documentElement;
    root.style.colorScheme = dark ? 'dark' : 'light';
    for (const [key, value] of Object.entries(theme || {})) root.style.setProperty(`--${key.replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`)}`, value);
  }
  window.HistoryTheme = { presets, apply };
})();
