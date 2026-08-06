'use strict';

const crypto = require('crypto');
const createApp = require('./lib/simpleHTTP.js');

// Encrypted cookies need a secret; fall back to an ephemeral one so the example runs as-is.
const cookieSecret = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.COOKIE_SECRET) {
    console.warn('COOKIE_SECRET is not set; using a random secret. Cookies will not survive a restart.');
}

const server = createApp({
    port: Number(process.env.PORT) || 8080,
    host: process.env.HOST || '127.0.0.1',
    docroot: './public',
    debug: true,
    cookieSecret,
    websocket: {
        origin: ['http://localhost', 'http://localhost:8080'],
        maxPayload: 1024 * 1024
    }
    // To enable TLS, add:
    // ssl: { cert: './cert.pem', key: './key.pem' }
});

server.get('/', (req, res) => {
    console.log('encrypted cookies:', req.encryptedCookies);
    res.setHeader('Set-Cookie', res.encryptedCookieSerialize('sessionData', {
        message: 'HELLO',
        issuedAt: Date.now()
    }, {
        httpOnly: true,
        sameSite: 'lax',
        secure: Boolean(server.http.setSecureContext),
        maxAge: 60 * 60 * 24 * 7
    }));
    res.json({ type: 'msg', msg: 'hello' });
});

server.post('/', async (req, res, form) => {
    console.log('query:', req.url.query);
    console.log('form:', form);
    res.json({ status: 'ok' });
});

server.onconnect('/', (connection, req) => {
    connection.on('message', (message, isBinary) => {
        const value = isBinary ? message : message.toString('utf8');
        console.log('message:', value);
    });

    connection.on('close', () => {
        console.log(`${req.socket.remoteAddress} left`);
    });
});
