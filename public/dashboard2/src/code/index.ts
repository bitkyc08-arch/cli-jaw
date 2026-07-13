// 060 — the ONLY public entry of the Code lazy chunk. The shell reaches this
// module exclusively through `import('../code/index.ts')` (React.lazy); a
// top-level value import from shell/providers would defeat the lazy boundary.
export { CodeTab, default } from './CodeTab.tsx';
