// Phase 9 — sidebar search input.
//
// Tiny controlled input. Substring filter is applied by the sidebar itself.

type Props = {
    value: string;
    onChange: (next: string) => void;
};

export function SidebarSearch({ value, onChange }: Props) {
    return (
        <div className="settings-sidebar-search">
            <input
                type="search"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                placeholder="Search settings…"
                aria-label="Search settings"
                spellCheck={false}
                autoComplete="off"
            />
        </div>
    );
}
