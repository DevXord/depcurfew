// Tests must never touch the network. Every outbound API is replaced with one that fails loudly.
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

function blocked(api: string): Error {
  return new Error(`Network access is disabled in tests (${api})`);
}

function throwing(api: string): () => never {
  return () => {
    throw blocked(api);
  };
}

globalThis.fetch = (() => Promise.reject(blocked('fetch'))) as typeof fetch;
net.Socket.prototype.connect = throwing('net.Socket.connect') as typeof net.Socket.prototype.connect;
net.connect = throwing('net.connect') as typeof net.connect;
net.createConnection = throwing('net.createConnection') as typeof net.createConnection;
tls.connect = throwing('tls.connect') as typeof tls.connect;
http.request = throwing('http.request') as typeof http.request;
http.get = throwing('http.get') as typeof http.get;
https.request = throwing('https.request') as typeof https.request;
https.get = throwing('https.get') as typeof https.get;

// Propagate the patches to named ESM imports such as `import { request } from 'node:http'`.
syncBuiltinESMExports();
