type TemplateVars = Record<string, string>;

const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

function defaultVars(): TemplateVars {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    const yyyy = now.getFullYear();
    const mm = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    const hh = pad(now.getHours());
    const mi = pad(now.getMinutes());
    return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${mi}`, year: String(yyyy), month: mm, day: dd };
}

export function applyTemplate(template: string, extraVars: TemplateVars = {}): string {
    const vars: TemplateVars = { ...defaultVars(), ...extraVars };
    return template.replace(VARIABLE_PATTERN, (match, key: string) => Object.hasOwn(vars, key) ? vars[key] : match);
}
