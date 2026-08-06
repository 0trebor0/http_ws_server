# HTTP-WS-Server

A small HTTP/HTTPS server with WebSocket support, static file serving, multipart uploads
and encrypted cookies. No framework, no middleware stack.

## Install

```
npm install http_ws_server
```

## Example

```js
const createApp = require('http_ws_server');

const server = createApp({
    port: 8080,
    host: '127.0.0.1',
    docroot: './public',
    cookieSecret: process.env.COOKIE_SECRET,
    websocket: { origin: ['http://localhost:8080'] }
});

server.get('/', (req, res) => {
    res.setHeader('Set-Cookie', res.encryptedCookieSerialize('sess', { user: 1 }));
    res.json({ msg: 'hello', query: req.url.query });
});

server.post('/upload', async (req, res, form) => {
    console.log(form.fields, form.files);
    res.json({ status: 'ok' });
});

server.onconnect('/ws', (connection, req) => {
    connection.on('message', (message, isBinary) => {
        connection.send(isBinary ? message : `echo:${message}`);
    });
});
```

The server starts listening as soon as `createApp()` returns; there is no separate
`listen()` call. See [example.js](example.js) for a runnable version.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `port` | `8080` | Port to listen on. `0` picks a free port. |
| `host` | all interfaces | Interface to bind. |
| `docroot` | none | Directory served when no route matches. Must exist. |
| `uploadDir` | OS temp dir | Where multipart uploads are staged. Created `0700`, but POSIX modes are ignored on Windows — point it at a directory you have restricted yourself if that matters. |
| `debug` | `false` | Log each request and the listening address. |
| `cookieSecret` | none | Key for encrypted cookies. At least 32 characters, or a 32-byte Buffer. |
| `cookieSecrets` | none | Array of keys for rotation; the first one signs, all are tried on read. |
| `ssl` | none | `{ cert, key }` file paths. Both are required. |
| `websocket` | none | `{ origin: [...], maxPayload }`. Omit to disable WebSockets entirely. |
| `maxFileSize` | 10 MB | Per-file upload limit. |
| `maxTotalFileSize` | 20 MB | Combined upload limit for a single request. |
| `maxFields` | 1000 | Maximum number of form fields. |

Requests that exceed an upload limit are answered with `413`; a body that cannot be
parsed gets `400`. Empty files are rejected.

## Routing

* `server.get(path, handler)` — handler receives `(req, res)`.
* `server.post(path, handler)` — handler receives `(req, res, form)` where `form` is
  `{ fields, files }`.
* `server.onconnect(path, handler)` — handler receives `(connection, req)`.
* `server.close(callback)` — closes the WebSocket server and the HTTP server.

Paths are matched exactly; there are no parameters or wildcards. `HEAD` requests are
served by the matching `get` handler. Handlers may be `async`, and the response is
ended automatically if the handler does not end it.

Uploaded files are deleted once the handler returns. Move anything you want to keep
before that. In `form.fields` and `form.files`, a name that appears once holds a single
value and a name that repeats holds an array.

Routes can also be registered on the module before any server exists; the first server
created takes them:

```js
const createApp = require('http_ws_server');
createApp.get('/health', (req, res) => res.json({ ok: true }));
const server = createApp({ port: 8080 });
```

## Request additions

* `req.url` — `{ href, pathname, query, searchParams }`. Note this replaces the usual
  request URL string.
* `req.method` — lowercased.
* `req.cookies` — parsed cookie pairs.
* `req.encryptedCookies` — decrypted values, when `cookieSecret` is set.
* `req.invalidEncryptedCookies` — names that failed to decrypt or were tampered with.

## Response additions

* `res.json(data, statusCode = 200)`
* `res.notfound()`
* `res.file(path)` — streams a file with `Content-Type` and HTTP range support.
* `res.cookieSerialize(name, value, options)` — plain cookie.
* `res.encryptedCookieSerialize(name, value, options)` — AES-256-GCM cookie, defaults to
  `httpOnly`, `sameSite=lax`, `path=/`. Requires `cookieSecret`.

## Static files

When `docroot` is set and no route matches, `GET`/`HEAD` fall back to serving files from
it. A directory serves its `index.html`. Paths are resolved and re-checked against the
document root's real path, so `../` traversal and symlinks cannot escape it.

## WebSockets

Connections are accepted only when the `Origin` header is in `websocket.origin` **and** a
handler is registered for the path. Anything else is closed with code `1008`.

## Tests

```
npm test
```

## Built With

* [cookie](https://www.npmjs.com/package/cookie)
* [formidable](https://www.npmjs.com/package/formidable)
* [mime-types](https://www.npmjs.com/package/mime-types)
* [ws](https://www.npmjs.com/package/ws)

## License

MIT
