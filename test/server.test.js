'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');
const createApp = require('../lib/simpleHTTP.js');

const SECRET = 'a'.repeat(32);
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-http-test-'));
const docroot = path.join(fixtures, 'docroot');
const uploadDir = path.join(fixtures, 'uploads');

fs.mkdirSync(path.join(docroot, 'sub'), { recursive: true });
fs.writeFileSync(path.join(docroot, 'index.html'), 'HELLO-STATIC-0123456789');
fs.writeFileSync(path.join(docroot, 'sub', 'index.html'), 'SUBFILE');

// Registered on the module before any server exists; the first server created takes it.
createApp.get('/pending', (req, res) => res.json({ pending: true }));

let app;
let port;

test.before(async () => {
    app = createApp({
        port: 0,
        host: '127.0.0.1',
        docroot,
        uploadDir,
        cookieSecret: SECRET,
        maxFileSize: 100,
        maxTotalFileSize: 500,
        websocket: { origin: ['http://localhost'] }
    });

    app.get('/hello', (req, res) => res.json({ ok: true, query: req.url.query }));
    app.get('/cookie', (req, res) => {
        res.setHeader('Set-Cookie', res.encryptedCookieSerialize('sess', { u: 1 }));
        res.json({ seen: req.encryptedCookies });
    });
    app.get('/boom', () => { throw new Error('handler blew up'); });
    app.post('/upload', (req, res, form) => {
        res.json({
            fields: form.fields,
            files: Object.keys(form.files),
            filenames: Object.values(form.files).flat().map((file) => file.originalFilename)
        });
    });
    app.onconnect('/ws', (connection) => {
        connection.on('message', (message) => connection.send(`echo:${message.toString()}`));
    });

    await new Promise((resolve) => {
        if (app.http.listening) return resolve();
        app.http.once('listening', resolve);
    });
    port = app.http.address().port;
});

test.after(async () => {
    app.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(fixtures, { recursive: true, force: true });
});

function request(options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, ...options }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8')
            }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// Sends a hand-written request so deliberately malformed headers survive Node's client.
function rawRequest(text, waitMs = 500) {
    return new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
        let buffer = '';
        socket.on('data', (chunk) => { buffer += chunk.toString(); });
        const finish = () => { socket.destroy(); resolve(buffer); };
        socket.on('close', finish);
        socket.on('error', finish);
        setTimeout(finish, waitMs);
    });
}

function hasOpenssl() {
    try {
        execFileSync('openssl', ['version'], { stdio: 'ignore' });
        return true;
    } catch (_) {
        return false;
    }
}

function rawStatus(text) {
    const match = /^HTTP\/1\.[01] (\d{3})/.exec(text);
    return match ? Number(match[1]) : null;
}

function multipart(name, filename, content) {
    const boundary = '----simplehttptest';
    const body = filename
        ? `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`
            + `Content-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`
        : `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${content}\r\n--${boundary}--\r\n`;
    return { boundary, body };
}

test('GET route returns the handler response', async () => {
    const res = await request({ method: 'GET', path: '/hello?a=1' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true, query: { a: '1' } });
});

test('HEAD resolves to the GET handler and sends no body', async () => {
    const res = await request({ method: 'HEAD', path: '/hello' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, '');
});

test('HEAD on a static file sends headers without a body', async () => {
    const res = await request({ method: 'HEAD', path: '/index.html' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, '');
});

test('unparseable Host header is a 400, not a 500', async () => {
    const raw = await rawRequest('GET /index.html HTTP/1.1\r\nHost: a b c\r\nConnection: close\r\n\r\n');
    assert.strictEqual(rawStatus(raw), 400);
});

test('NUL byte in the path is a 400, not a 500', async () => {
    const res = await request({ method: 'GET', path: '/index.html%00.png' });
    assert.strictEqual(res.status, 400);
});

test('static index.html is served for a directory', async () => {
    const root = await request({ method: 'GET', path: '/' });
    assert.strictEqual(root.status, 200);
    assert.match(root.body, /HELLO-STATIC/);

    const sub = await request({ method: 'GET', path: '/sub' });
    assert.strictEqual(sub.status, 200);
    assert.match(sub.body, /SUBFILE/);
});

test('path traversal is rejected in encoded and separator forms', async () => {
    for (const target of ['/../../package.json', '/%2e%2e%2f%2e%2e%2fpackage.json', '/sub/..%5c..%5cpackage.json']) {
        const res = await request({ method: 'GET', path: target });
        assert.strictEqual(res.status, 404, `expected 404 for ${target}`);
        assert.doesNotMatch(res.body, /http_ws_server/);
    }
});

test('invalid percent-encoding is a 400', async () => {
    const res = await request({ method: 'GET', path: '/%ZZ' });
    assert.strictEqual(res.status, 400);
});

test('range requests are honoured', async () => {
    const partial = await request({ method: 'GET', path: '/index.html', headers: { Range: 'bytes=0-4' } });
    assert.strictEqual(partial.status, 206);
    assert.strictEqual(partial.body, 'HELLO');
    const size = fs.statSync(path.join(docroot, 'index.html')).size;
    assert.strictEqual(partial.headers['content-range'], `bytes 0-4/${size}`);

    const suffix = await request({ method: 'GET', path: '/index.html', headers: { Range: 'bytes=-3' } });
    assert.strictEqual(suffix.status, 206);
    assert.strictEqual(suffix.body, '789');

    const unsatisfiable = await request({ method: 'GET', path: '/index.html', headers: { Range: 'bytes=99999-' } });
    assert.strictEqual(unsatisfiable.status, 416);
});

test('unknown paths and methods are 404', async () => {
    assert.strictEqual((await request({ method: 'GET', path: '/nope' })).status, 404);
    assert.strictEqual((await request({ method: 'POST', path: '/nope' })).status, 404);
    assert.strictEqual((await request({ method: 'PUT', path: '/hello' })).status, 404);
});

test('a throwing handler produces a 500', async () => {
    const res = await request({ method: 'GET', path: '/boom' });
    assert.strictEqual(res.status, 500);
});

test('encrypted cookies round-trip and reject tampering', async () => {
    const issued = await request({ method: 'GET', path: '/cookie' });
    const setCookie = issued.headers['set-cookie'][0];
    assert.match(setCookie, /^sess=v1\./);
    assert.match(setCookie, /HttpOnly/);

    const jar = setCookie.split(';')[0];
    const replayed = await request({ method: 'GET', path: '/cookie', headers: { Cookie: jar } });
    assert.deepStrictEqual(JSON.parse(replayed.body).seen, { sess: { u: 1 } });

    const tampered = `${jar.slice(0, -2)}AA`;
    const rejected = await request({ method: 'GET', path: '/cookie', headers: { Cookie: tampered } });
    assert.deepStrictEqual(JSON.parse(rejected.body).seen, {});
});

test('a single-valued field arrives as a scalar, a repeated one as an array', async () => {
    const boundary = '----simplehttptest';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue-a\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="many"\r\n\r\none\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="many"\r\n\r\ntwo\r\n`
        + `--${boundary}--\r\n`;
    const res = await request({
        method: 'POST',
        path: '/upload',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': Buffer.byteLength(body)
        }
    }, body);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body).fields, { a: 'value-a', many: ['one', 'two'] });
});

test('an empty file is rejected rather than handed to the handler', async () => {
    const { boundary, body } = multipart('f', 'empty.txt', '');
    const res = await request({
        method: 'POST',
        path: '/upload',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': Buffer.byteLength(body)
        }
    }, body);
    assert.notStrictEqual(res.status, 200);
});

test('uploaded temp files are removed once the handler returns', async () => {
    const { boundary, body } = multipart('f', 's.txt', 'hello-file');
    const res = await request({
        method: 'POST',
        path: '/upload',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': Buffer.byteLength(body)
        }
    }, body);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body).files, ['f']);
    assert.deepStrictEqual(JSON.parse(res.body).filenames, ['s.txt']);

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepStrictEqual(fs.readdirSync(uploadDir), []);
});

test('a body over maxTotalFileSize is refused with 413', async () => {
    const { boundary, body } = multipart('f', 'big.txt', 'Z'.repeat(600));
    const res = await request({
        method: 'POST',
        path: '/upload',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': Buffer.byteLength(body)
        }
    }, body);
    assert.strictEqual(res.status, 413);
});

test('a file over maxFileSize is refused with 413, not 500', async () => {
    const { boundary, body } = multipart('f', 'big.txt', 'Z'.repeat(200));
    const res = await request({
        method: 'POST',
        path: '/upload',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': Buffer.byteLength(body)
        }
    }, body);
    assert.strictEqual(res.status, 413);
});

test('an unparseable body is refused with 400, not 500', async () => {
    const body = 'not-multipart-at-all';
    const res = await request({
        method: 'POST',
        path: '/upload',
        headers: {
            'Content-Type': 'multipart/form-data',
            'Content-Length': Buffer.byteLength(body)
        }
    }, body);
    assert.strictEqual(res.status, 400);
});

test('websocket echoes on an allowed origin', async () => {
    const received = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'http://localhost' });
        const timer = setTimeout(() => { ws.terminate(); reject(new Error('timed out')); }, 3000);
        ws.on('open', () => ws.send('hi'));
        ws.on('message', (message) => { clearTimeout(timer); ws.close(); resolve(message.toString()); });
        ws.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
    assert.strictEqual(received, 'echo:hi');
});

test('websocket rejects a disallowed origin and an unknown path', async () => {
    const closeCode = (url, origin) => new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { origin });
        const timer = setTimeout(() => { ws.terminate(); reject(new Error('timed out')); }, 3000);
        ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
        ws.on('error', () => {});
    });

    assert.strictEqual(await closeCode(`ws://127.0.0.1:${port}/ws`, 'http://evil.example'), 1008);
    assert.strictEqual(await closeCode(`ws://127.0.0.1:${port}/nows`, 'http://localhost'), 1008);
});

test('short cookie secrets are rejected at construction', () => {
    const headers = require('../lib/headers.js');
    assert.throws(() => headers.create({ cookieSecret: 'short' }), /at least 32 characters/);
});

test('encrypted cookies require a configured secret', () => {
    const headers = require('../lib/headers.js');
    const req = { headers: {} };
    const res = {};
    headers.create({})(req, res);
    assert.throws(() => res.encryptedCookieSerialize('x', 1), /cookieSecret is required/);
});

test('module-level routes go to the first server and are not inherited by later ones', async () => {
    const mine = await request({ method: 'GET', path: '/pending' });
    assert.strictEqual(mine.status, 200);
    assert.deepStrictEqual(JSON.parse(mine.body), { pending: true });

    const second = createApp({ port: 0, host: '127.0.0.1', cookieSecret: SECRET });
    try {
        await new Promise((resolve) => {
            if (second.http.listening) return resolve();
            second.http.once('listening', resolve);
        });
        const theirs = await request({
            method: 'GET',
            path: '/pending',
            port: second.http.address().port
        });
        assert.strictEqual(theirs.status, 404);
    } finally {
        second.close();
    }
});

test('serves over TLS when ssl is configured', { skip: !hasOpenssl() }, async () => {
    const certPath = path.join(fixtures, 'cert.pem');
    const keyPath = path.join(fixtures, 'key.pem');
    execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath,
        '-days', '1', '-subj', '/CN=localhost'
    ], { stdio: 'ignore' });

    const secure = createApp({
        port: 0,
        host: '127.0.0.1',
        cookieSecret: SECRET,
        ssl: { cert: certPath, key: keyPath }
    });
    secure.get('/tls', (req, res) => res.json({ secure: true }));

    try {
        await new Promise((resolve) => {
            if (secure.http.listening) return resolve();
            secure.http.once('listening', resolve);
        });

        const body = await new Promise((resolve, reject) => {
            const req = https.request({
                host: '127.0.0.1',
                port: secure.http.address().port,
                path: '/tls',
                method: 'GET',
                rejectUnauthorized: false
            }, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            });
            req.on('error', reject);
            req.end();
        });
        assert.deepStrictEqual(JSON.parse(body), { secure: true });
    } finally {
        secure.close();
    }
});

test('ssl config requires both cert and key', () => {
    assert.throws(
        () => createApp({ port: 0, host: '127.0.0.1', ssl: { cert: 'only-cert' } }),
        /Both ssl.cert and ssl.key are required/
    );
});

test('a missing docroot is rejected at construction', () => {
    assert.throws(
        () => createApp({ port: 0, host: '127.0.0.1', docroot: path.join(fixtures, 'nope') }),
        /Document root does not exist/
    );
});

// NTFS alternate data streams are a Windows-only aliasing route to the same file.
test('NTFS alternate data stream suffix is not served', { skip: path.sep !== '\\' }, async () => {
    const res = await request({ method: 'GET', path: '/index.html::$DATA' });
    assert.strictEqual(res.status, 404);
    assert.doesNotMatch(res.body, /HELLO-STATIC/);
});
