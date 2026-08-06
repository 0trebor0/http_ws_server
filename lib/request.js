'use strict';

const fs = require('fs');
const { pipeline } = require('stream');
const { promisify } = require('util');
const { URL } = require('url');
const mime = require('mime-types');

const pipe = promisify(pipeline);

function parseRange(value, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(value || '');
    if (!match || size === 0) return null;

    let start;
    let end;

    if (match[1] === '') {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
        start = Math.max(size - suffixLength, 0);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] === '' ? size - 1 : Number(match[2]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
        if (start < 0 || start >= size || end < start) return null;
        end = Math.min(end, size - 1);
    }

    return { start, end };
}

module.exports = (req, res = null) => {
    const host = req.headers && req.headers.host ? req.headers.host : 'localhost';
    const parsed = new URL(req.url, `http://${host}`);

    req.url = {
        href: parsed.href,
        pathname: parsed.pathname,
        query: Object.fromEntries(parsed.searchParams.entries()),
        searchParams: parsed.searchParams
    };
    req.method = String(req.method || 'GET').toLowerCase();

    if (!res) return;

    res.json = (data, statusCode = 200) => {
        if (res.writableEnded) return;
        const body = JSON.stringify(data);
        res.writeHead(statusCode, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body)
        });
        res.end(body);
    };

    res.notfound = () => {
        if (res.writableEnded) return;
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
    };

    res.file = async (filename) => {
        const stat = await fs.promises.stat(filename);
        if (!stat.isFile()) throw new Error('Requested path is not a file');

        const contentType = mime.lookup(filename) || 'application/octet-stream';
        const baseHeaders = {
            'Accept-Ranges': 'bytes',
            'Content-Type': contentType,
            'X-Content-Type-Options': 'nosniff'
        };
        const rangeHeader = req.headers.range;

        if (rangeHeader) {
            const range = parseRange(rangeHeader, stat.size);
            if (!range) {
                res.writeHead(416, {
                    ...baseHeaders,
                    'Content-Range': `bytes */${stat.size}`
                });
                res.end();
                return;
            }

            const contentLength = range.end - range.start + 1;
            res.writeHead(206, {
                ...baseHeaders,
                'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
                'Content-Length': contentLength
            });
            if (req.method === 'head') return res.end();
            await pipe(fs.createReadStream(filename, range), res);
            return;
        }

        res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
        if (req.method === 'head') return res.end();
        await pipe(fs.createReadStream(filename), res);
    };
};
