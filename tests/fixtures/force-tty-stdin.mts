// Preload that makes stdin claim to be a terminal.
//
// `jaw slack setup` picks its interactive branch from process.stdin.isTTY
// (#475), and a spawned test child has no terminal. Forcing the flag lets the
// suite pin the prompting path without a PTY — which would mean `script`,
// whose arguments differ between BSD and GNU and would make the test
// platform-specific.
//
// One caveat drove the shape of the test that uses this: in terminal mode
// readline drains the whole pipe on its first read, so only the FIRST
// question can be answered this way. The caller therefore passes every other
// value as a flag, leaving exactly one prompt.
process.stdin.isTTY = true;
