const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

function describeApiBody(body) {
    let parsed = body;
    if (typeof body === 'string') {
        const trimmed = body.trim();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
            return `non-json ${body.length} bytes`;
        }
        try {
            parsed = JSON.parse(body);
        } catch (e) {
            return `unparsed ${body.length} bytes`;
        }
    }
    if (!parsed || typeof parsed !== 'object') {
        return 'empty body';
    }

    const fields = [
        's_status',
        'i_apiErrorCode',
        'i_apiErrorType',
        's_apiErrorDescription',
        's_apiErrorExtendedInformations',
        's_apiErrorContext'
    ];
    const parts = fields
        .filter((key) => parsed[key] !== undefined)
        .map((key) => `${key}=${parsed[key]}`);
    if (parts.length === 0) {
        return `keys=${Object.keys(parsed).join(',') || 'none'}`;
    }
    return parts.join(' ');
}

// ws only accepts these close codes from close(); others (1005, 1006, ...) are reserved.
function safeCloseCode(code) {
    const valid = code === 1000 || (code >= 1001 && code <= 1003) ||
        (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
    return valid ? code : 1000;
}

function safeCloseReason(reason) {
    return String(reason || '').slice(0, 120);
}

class ClientProxy {
    constructor(serverUrl, localPort = 9983, httpsOptions = null) {
        this.serverUrl = serverUrl;
        this.localPort = localPort;
        this.httpsPort = httpsOptions ? httpsOptions.port : null;
        this.clientId = `client_${uuidv4()}`;
        this.app = express();
        this.server = http.createServer(this.app);
        this.httpsServer = httpsOptions
            ? https.createServer({ key: httpsOptions.key, cert: httpsOptions.cert }, this.app)
            : null;
        this.ws = null;
        this.pendingRequests = new Map();
        this.tunnels = new Map();
        this.isConnected = false;
        this.localWss = new WebSocket.Server({
            noServer: true,
            handleProtocols: (protocols) => protocols.values().next().value || false
        });
        
        this.setupExpress();
        this.setupWebSocketTunnel(this.server);
        if (this.httpsServer) {
            this.setupWebSocketTunnel(this.httpsServer);
        }
        this.connectToServer();
    }

    setupWebSocketTunnel(server) {
        server.on('upgrade', (req, socket, head) => {
            if (!this.isConnected) {
                console.error(`WebSocket ${req.url} refused: not connected to relay server`);
                socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }
            this.localWss.handleUpgrade(req, socket, head, (localWs) => {
                this.openTunnel(localWs, req);
            });
        });
    }

    openTunnel(localWs, req) {
        const connId = uuidv4();
        this.tunnels.set(connId, localWs);

        const headers = {};
        ['origin', 'user-agent', 'cookie', 'sec-websocket-protocol'].forEach((name) => {
            if (req.headers[name]) {
                headers[name] = req.headers[name];
            }
        });

        this.sendToRelay({ type: 'ws_open', connId, path: req.url, headers });
        console.log(`WebSocket ${connId} opened: ${req.url} origin=${req.headers.origin || 'none'}`);

        localWs.on('message', (data, isBinary) => {
            this.sendToRelay({
                type: 'ws_message',
                connId,
                binary: isBinary,
                data: isBinary ? Buffer.from(data).toString('base64') : data.toString()
            });
        });

        localWs.on('close', (code, reason) => {
            if (!this.tunnels.has(connId)) {
                return;
            }
            this.tunnels.delete(connId);
            this.sendToRelay({ type: 'ws_close', connId, code, reason: reason.toString() });
            console.log(`WebSocket ${connId} closed by browser (code ${code})`);
        });

        localWs.on('error', (error) => {
            console.error(`WebSocket ${connId} browser error: ${error.message}`);
        });
    }

    handleTunnelMessage(message) {
        const localWs = this.tunnels.get(message.connId);
        if (!localWs || localWs.readyState !== WebSocket.OPEN) {
            return;
        }
        localWs.send(message.binary ? Buffer.from(message.data, 'base64') : message.data);
    }

    handleTunnelClose(message) {
        const localWs = this.tunnels.get(message.connId);
        if (!localWs) {
            return;
        }
        this.tunnels.delete(message.connId);
        console.log(`WebSocket ${message.connId} closed by remote DmpConnect (code ${message.code}${message.reason ? `, reason: ${message.reason}` : ''})`);
        localWs.close(safeCloseCode(message.code), safeCloseReason(message.reason));
    }

    closeAllTunnels(reason) {
        this.tunnels.forEach((localWs) => localWs.close(1011, safeCloseReason(reason)));
        this.tunnels.clear();
    }

    sendToRelay(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    setupExpress() {
        // Middleware
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
        // Efficience posts JSON with Content-Type: text/plain. Without this, the body is dropped.
        this.app.use(express.text({ type: 'text/plain', limit: '10mb' }));
        
        // CORS middleware
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
            
            if (req.method === 'OPTIONS') {
                res.sendStatus(200);
            } else {
                next();
            }
        });

        // Catch-all route to proxy all requests
        this.app.all('*', (req, res) => {
            this.handleRequest(req, res);
        });

        // Error handling
        this.app.use((error, req, res, next) => {
            console.error('Express error:', error);
            res.status(500).json({ error: 'Internal server error' });
        });
    }

    connectToServer() {
        console.log(`Connecting to WebSocket server at ${this.serverUrl}...`);
        
        this.ws = new WebSocket(this.serverUrl);
        
        this.ws.on('open', () => {
            console.log('Connected to WebSocket server');
            this.isConnected = true;
            this.startHeartbeat();
            
            // Register as client
            this.ws.send(JSON.stringify({
                type: 'register',
                role: 'client',
                clientId: this.clientId
            }));
        });

        this.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                this.handleMessage(message);
            } catch (error) {
                console.error('Error parsing WebSocket message:', error);
            }
        });

        this.ws.on('close', (code, reason) => {
            const why = reason && reason.length ? reason.toString() : 'none';
            console.log(`Disconnected from WebSocket server (code ${code}, reason: ${why})`);
            this.isConnected = false;
            this.stopHeartbeat();
            this.closeAllTunnels('Relay connection lost');
            
            // Reconnect after 5 seconds
            setTimeout(() => {
                console.log('Attempting to reconnect...');
                this.connectToServer();
            }, 5000);
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error);
            this.isConnected = false;
        });
    }

    handleMessage(message) {
        switch (message.type) {
            case 'registered':
                console.log(`Registered as ${message.role} with ID: ${message.clientId}`);
                break;
                
            case 'response':
                this.handleResponse(message);
                break;
                
            case 'error':
                this.handleError(message);
                break;

            case 'ws_message':
                this.handleTunnelMessage(message);
                break;

            case 'ws_close':
                this.handleTunnelClose(message);
                break;
                
            default:
                console.log('Unknown message type:', message.type);
        }
    }

    handleRequest(req, res) {
        if (!this.isConnected) {
            return res.status(503).json({ 
                error: 'Service unavailable - not connected to relay server' 
            });
        }

        const requestId = uuidv4();
        const startedAt = Date.now();

        if (typeof req.body === 'string' && req.body.trim()) {
            try {
                const parsed = JSON.parse(req.body);
                if (parsed && typeof parsed === 'object') {
                    req.body = parsed;
                    req.headers['content-type'] = 'application/json';
                }
            } catch (e) {
                // Keep the raw text body when it is not JSON.
            }
        }

        const bodyKeys = req.body && typeof req.body === 'object' ? Object.keys(req.body) : [];
        
        // Set timeout for request (30 seconds)
        const timeout = setTimeout(() => {
            if (this.pendingRequests.has(requestId)) {
                this.pendingRequests.delete(requestId);
                console.error(`Timeout ${requestId} ${req.method} ${req.path} after 30000ms, relay still connected=${this.isConnected}`);
                res.status(504).json({ error: 'Request timeout' });
            }
        }, 30000);

        this.pendingRequests.set(requestId, { res, timeout, startedAt });

        // Prepare request data
        const requestData = {
            type: 'request',
            requestId: requestId,
            method: req.method,
            path: req.path,
            headers: req.headers,
            body: req.body,
            query: req.query
        };

        // Send request to server
        this.ws.send(JSON.stringify(requestData));
        const scheme = req.secure ? 'https' : 'http';
        const host = req.secure ? 'localhost.icanopee.net' : (req.hostname || 'localhost');
        console.log(`Request ${requestId} sent: ${req.method} ${scheme}://${host}:${req.socket.localPort}${req.path} content-type=${req.get('content-type') || 'none'} bodyKeys=${bodyKeys.join(',') || 'none'}`);
    }

    handleResponse(message) {
        const pendingRequest = this.pendingRequests.get(message.requestId);
        if (!pendingRequest) {
            console.log(`No pending request found for ID: ${message.requestId}`);
            return;
        }

        clearTimeout(pendingRequest.timeout);

        // Send response
        const res = pendingRequest.res;
        res.status(message.statusCode);
        
        // Set headers
        if (message.headers) {
            Object.entries(message.headers).forEach(([key, value]) => {
                res.set(key, value);
            });
        }

        // Send body
        if (message.body) {
            res.send(message.body);
        } else {
            res.end();
        }

        // Clean up
        this.pendingRequests.delete(message.requestId);
        const elapsed = Date.now() - pendingRequest.startedAt;
        console.log(`Response ${message.requestId} ${message.statusCode} in ${elapsed}ms ${describeApiBody(message.body)}`);
    }

    handleError(message) {
        const pendingRequest = this.pendingRequests.get(message.requestId);
        if (!pendingRequest) {
            console.log(`No pending request found for error ID: ${message.requestId}`);
            return;
        }

        clearTimeout(pendingRequest.timeout);

        // Send error response
        const res = pendingRequest.res;
        res.status(500).json({ error: message.error });

        // Clean up
        this.pendingRequests.delete(message.requestId);
        const elapsed = Date.now() - pendingRequest.startedAt;
        console.log(`Error response ${message.requestId} in ${elapsed}ms: ${message.error}`);
    }

    startHeartbeat() {
        this.stopHeartbeat();
        // Keep the socket active inside the Elastic Beanstalk ~60s idle timeout.
        this.heartbeat = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, 25000);
    }

    stopHeartbeat() {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
    }

    start() {
        this.server.on('error', (error) => {
            console.error(`HTTP listener error on port ${this.localPort}: ${error.message}`);
        });
        this.server.listen(this.localPort, () => {
            console.log(`HTTP forwarder listening on http://localhost:${this.localPort}`);
        });

        if (!this.httpsServer) {
            console.error('HTTPS forwarder is not running. Efficience calls https://localhost.icanopee.net:9982 and will miss this proxy.');
            console.error('Create a locally trusted certificate with: npm run setup-cert');
            return;
        }

        this.httpsServer.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`Port ${this.httpsPort} is already in use. Stop the local dmpconnect-js2 process, then restart this forwarder.`);
                return;
            }
            console.error(`HTTPS listener error on port ${this.httpsPort}: ${error.message}`);
        });
        this.httpsServer.listen(this.httpsPort, '127.0.0.1', () => {
            console.log(`HTTPS forwarder listening on https://localhost.icanopee.net:${this.httpsPort}`);
            console.log('Point Semble and Efficience at that address. Both requests are forwarded to the relay.');
        });
    }
}

function loadHttpsOptions() {
    const httpsPort = Number(process.env.HTTPS_PORT || 9982);
    if (!httpsPort) {
        return null;
    }

    const certDir = path.join(__dirname, 'certs');
    const keyPath = process.env.TLS_KEY_PATH || path.join(certDir, 'localhost.icanopee.net-key.pem');
    const certPath = process.env.TLS_CERT_PATH || path.join(certDir, 'localhost.icanopee.net.pem');
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        console.error(`Missing TLS certificate files:\n  ${certPath}\n  ${keyPath}`);
        return null;
    }

    return {
        port: httpsPort,
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
    };
}

// Configuration
const SERVER_URL = process.env.RELAY_SERVER_URL || 'ws://card-reader-env.eba-azfgrdve.eu-central-1.elasticbeanstalk.com/';
const LOCAL_PORT = process.env.CLIENT_PORT || 9983;

// Start the client proxy
const clientProxy = new ClientProxy(SERVER_URL, LOCAL_PORT, loadHttpsOptions());
clientProxy.start();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down client proxy...');
    if (clientProxy.ws) {
        clientProxy.ws.close();
    }

    const servers = [clientProxy.server, clientProxy.httpsServer].filter(Boolean);
    let remaining = servers.length;
    const finished = () => {
        remaining -= 1;
        if (remaining === 0) {
            process.exit(0);
        }
    };
    servers.forEach((server) => server.close(finished));
});
