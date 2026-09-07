import express from 'express';
const { registerMessagingRoutes } = process.env.FILE_OPEN_TEST_BUILT === '1'
    ? await import('../../dist/src/routes/messaging.js')
    : await import('../../src/routes/messaging.ts');

// Imports bind native dependencies using the real platform first. The route's
// Linux branch can then be exercised on macOS without opening a desktop app.
Object.defineProperty(process, 'platform', { value: 'linux' });
process.env.PATH = process.env.FILE_OPEN_TEST_BIN!;

const app = express();
app.use(express.json());
app.get('/probe', (_req, res) => res.json({ alive: true }));
registerMessagingRoutes(app, (req, res, next) => {
    if (req.headers['x-test-auth'] !== 'allow') {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }
    next();
});
const server = app.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') process.send?.({ port: address.port });
});
process.on('message', message => {
    if (message !== 'stop') return;
    server.closeAllConnections();
    server.close(() => process.exit(0));
});
