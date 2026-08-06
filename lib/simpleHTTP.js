'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const formidableModule = require('formidable');
const applyHeaders = require('./headers.js');
const enhanceRequest = require('./request.js');

const createForm = typeof formidableModule === 'function'
    ? formidableModule
    : formidableModule.formidable;

const pendingRoutes = { get: [], post: [], websocket: [] };

function isInside(root, candidate) {
    return candidate === root || candidate.startsWith(root + path.sep);
}

function flattenFiles(files) {
    return Object.values(files || {}).flatMap((value) =>
        Array.isArray(value) ? value : [value]
    );
}

async function removeUploadedFiles(files) {
    await Promise.all(flattenFiles(files).map(async (file) => {
        const filename = file && (file.filepath || file.path);
        if (!filename) return;
        try {
            await fs.promises.unlink(filename);
        } catch (error) {
            if (error.code !== 'ENOENT') console.error('Upload cleanup failed:', error);
        }
    }));
}

// formidable 3 always returns arrays; collapse single values so handlers keep seeing
// the scalar-unless-repeated shape this library has always passed them.
function unwrapSingletons(collection) {
    const result = {};
    for (const [name, value] of Object.entries(collection || {})) {
        result[name] = Array.isArray(value) && value.length === 1 ? value[0] : value;
    }
    return result;
}

function parseForm(form, req) {
    return new Promise((resolve, reject) => {
        form.parse(req, (error, fields, files) => {
            if (error) reject(error);
            else resolve([fields, files]);
        });
    });
}

module.exports = (config = {}) => {
    const debug = config.debug === true;
    const port = Number.isInteger(config.port) ? config.port : 8080;
    const host = config.host;
    // Routes registered on the module before any server existed belong to the first
    // server created; draining them keeps later instances independent.
    const routes = {
        get: new Map(pendingRoutes.get.splice(0)),
        post: new Map(pendingRoutes.post.splice(0))
    };
    const websocketRoutes = new Map(pendingRoutes.websocket.splice(0));
    const staticRoot = config.docroot ? path.resolve(config.docroot) : null;
    const uploadDir = path.resolve(config.uploadDir || path.join(os.tmpdir(), 'simple-http-uploads'));
    const maxTotalFileSize = config.maxTotalFileSize || 20 * 1024 * 1024;
    const cookieOptions = {
        cookieSecret: config.cookieSecret,
        cookieSecrets: config.cookieSecrets
    };
    const applyCookieHeaders = applyHeaders.create(cookieOptions);

    if (staticRoot && !fs.existsSync(staticRoot)) {
        throw new Error(`Document root does not exist: ${staticRoot}`);
    }
    fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });

    let server;
    if (config.ssl) {
        if (!config.ssl.cert || !config.ssl.key) {
            throw new Error('Both ssl.cert and ssl.key are required');
        }
        server = https.createServer({
            cert: fs.readFileSync(config.ssl.cert),
            key: fs.readFileSync(config.ssl.key)
        });
    } else {
        server = http.createServer();
    }

    const app = {
        port,
        http: server,
        websocket: null,
        get(routePath, callback) {
            routes.get.set(routePath, callback);
            return app;
        },
        post(routePath, callback) {
            routes.post.set(routePath, callback);
            return app;
        },
        onconnect(routePath, callback) {
            websocketRoutes.set(routePath, callback);
            return app;
        },
        close(callback) {
            if (app.websocket) app.websocket.close();
            return server.close(callback);
        }
    };

    async function serveStatic(req, res) {
        if (!staticRoot || !['get', 'head'].includes(req.method)) return false;

        let decodedPath;
        try {
            decodedPath = decodeURIComponent(req.url.pathname);
        } catch (_) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Bad request');
            return true;
        }

        // fs rejects NUL bytes with a thrown TypeError rather than an ENOENT-style code.
        if (decodedPath.includes('\0')) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Bad request');
            return true;
        }

        // On Windows a colon names an NTFS alternate data stream ("file.json::$DATA"),
        // which resolves to the same file under a path no access rule would recognise.
        if (path.sep === '\\' && decodedPath.includes(':')) return false;

        const candidate = path.resolve(staticRoot, `.${decodedPath}`);
        if (!isInside(staticRoot, candidate)) return false;

        try {
            let target = candidate;
            let stat = await fs.promises.stat(target);
            if (stat.isDirectory()) {
                target = path.join(target, 'index.html');
                stat = await fs.promises.stat(target);
            }
            if (!stat.isFile()) return false;

            const realRoot = await fs.promises.realpath(staticRoot);
            const realTarget = await fs.promises.realpath(target);
            if (!isInside(realRoot, realTarget)) return false;

            await res.file(realTarget);
            return true;
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
            throw error;
        }
    }

    server.on('request', async (req, res) => {
        // An unparseable request target or Host header is a client fault, not a server one.
        try {
            enhanceRequest(req, res);
        } catch (_) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Bad request');
            return;
        }

        try {
            applyCookieHeaders(req, res);

            if (debug) {
                console.log(`[HTTP][${req.socket.remoteAddress}][${req.method.toUpperCase()}] ${req.url.pathname}`);
            }

            // HEAD must resolve to the same handler as GET; Node suppresses the body itself.
            const method = req.method === 'head' ? 'get' : req.method;
            const handler = routes[method] && routes[method].get(req.url.pathname);
            if (handler) {
                if (method === 'post') {
                    const form = createForm({
                        uploadDir,
                        maxFileSize: config.maxFileSize || 10 * 1024 * 1024,
                        maxTotalFileSize,
                        maxFields: config.maxFields || 1000,
                        allowEmptyFiles: false
                    });

                    let files = {};
                    try {
                        let parsed;
                        try {
                            parsed = await parseForm(form, req);
                        } catch (error) {
                            // formidable tags its own failures with the status they warrant.
                            const status = Number.isInteger(error.httpCode) ? error.httpCode : 400;
                            res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
                            res.end(status === 413 ? 'Payload too large' : 'Bad request');
                            return;
                        }
                        files = parsed[1];
                        await handler(req, res, {
                            fields: unwrapSingletons(parsed[0]),
                            files: unwrapSingletons(files)
                        });
                    } finally {
                        await removeUploadedFiles(files);
                    }
                } else {
                    await handler(req, res);
                }
                if (!res.writableEnded) res.end();
                return;
            }

            if (await serveStatic(req, res)) return;
            res.notfound();
        } catch (error) {
            console.error(error);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            }
            if (!res.writableEnded) res.end('Internal server error');
        }
    });

    server.on('clientError', (error, socket) => {
        if (debug) console.error('Client error:', error.message);
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    if (config.websocket) {
        const allowedOrigins = new Set(config.websocket.origin || []);
        app.websocket = new WebSocket.Server({
            server,
            maxPayload: config.websocket.maxPayload || 1024 * 1024
        });

        app.websocket.on('connection', (connection, req) => {
            try {
                enhanceRequest(req);
                applyCookieHeaders(req);
                const originAllowed = allowedOrigins.has(req.headers.origin);
                const handler = websocketRoutes.get(req.url.pathname);

                if (!originAllowed || !handler) {
                    if (debug) console.log(`[DENIED][WEBSOCKET] ${req.url.pathname}`);
                    connection.close(1008, 'Connection not allowed');
                    return;
                }

                connection.on('error', (error) => console.error('WebSocket error:', error));
                Promise.resolve(handler(connection, req)).catch((error) => {
                    console.error(error);
                    connection.close(1011, 'Internal error');
                });
            } catch (error) {
                console.error(error);
                connection.close(1011, 'Internal error');
            }
        });
    }

    server.on('listening', () => {
        if (debug) {
            const protocol = config.ssl ? 'https' : 'http';
            console.log(`${protocol} started on port ${port}`);
        }
    });

    server.listen(port, host);
    return app;
};

module.exports.get = (routePath, callback) => {
    pendingRoutes.get.push([routePath, callback]);
};

module.exports.post = (routePath, callback) => {
    pendingRoutes.post.push([routePath, callback]);
};

module.exports.onconnect = (routePath, callback) => {
    pendingRoutes.websocket.push([routePath, callback]);
};
