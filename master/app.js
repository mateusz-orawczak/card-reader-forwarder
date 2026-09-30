const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const { URL } = require('url');

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

class MasterProxy {
    constructor(serverUrl, targetApiUrl) {
        this.serverUrl = serverUrl;
        this.targetApiUrl = targetApiUrl;
        this.ws = null;
        this.isConnected = false;
        this.tunnels = new Map();
        
        this.connectToServer();
    }

    connectToServer() {
        console.log(`Connecting to WebSocket server at ${this.serverUrl}...`);
        
        this.ws = new WebSocket(this.serverUrl);
        
        this.ws.on('open', () => {
            console.log('Connected to WebSocket server');
            this.isConnected = true;
            this.startHeartbeat();
            
            // Register as master
            this.ws.send(JSON.stringify({
                type: 'register',
                role: 'master'
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
            this.tunnels.forEach((tunnel) => tunnel.target.terminate());
            this.tunnels.clear();
            
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

    handleMessage(message) {
        switch (message.type) {
            case 'registered':
                console.log(`Registered as ${message.role}`);
                break;
                
            case 'request':
                this.handleRequest(message);
                break;

            case 'ws_open':
                this.openTunnel(message);
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

    sendToRelay(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    openTunnel(message) {
        const { connId, path: wsPath, headers = {} } = message;
        const targetUrl = new URL(wsPath || '/', this.targetApiUrl);
        targetUrl.protocol = targetUrl.protocol === 'https:' ? 'wss:' : 'ws:';

        const protocols = headers['sec-websocket-protocol']
            ? headers['sec-websocket-protocol'].split(',').map((p) => p.trim()).filter(Boolean)
            : undefined;
        const forwardHeaders = {};
        ['origin', 'user-agent', 'cookie'].forEach((name) => {
            if (headers[name]) {
                forwardHeaders[name] = headers[name];
            }
        });

        console.log(`WebSocket ${connId} opening ${targetUrl.href} origin=${headers.origin || 'none'}`);
        const target = new WebSocket(targetUrl.href, protocols, {
            headers: forwardHeaders,
            rejectUnauthorized: false
        });
        // Frames the browser sends before DmpConnect accepts the upgrade.
        const tunnel = { target, queue: [] };
        this.tunnels.set(connId, tunnel);

        target.on('open', () => {
            console.log(`WebSocket ${connId} connected to DmpConnect`);
            tunnel.queue.forEach((frame) => target.send(frame));
            tunnel.queue = [];
        });

        target.on('message', (data, isBinary) => {
            this.sendToRelay({
                type: 'ws_message',
                connId,
                binary: isBinary,
                data: isBinary ? Buffer.from(data).toString('base64') : data.toString()
            });
        });

        target.on('unexpected-response', (req, res) => {
            console.error(`WebSocket ${connId} rejected by DmpConnect: HTTP ${res.statusCode}`);
            target.terminate();
        });

        target.on('close', (code, reason) => {
            if (!this.tunnels.has(connId)) {
                return;
            }
            this.tunnels.delete(connId);
            console.log(`WebSocket ${connId} closed by DmpConnect (code ${code})`);
            this.sendToRelay({ type: 'ws_close', connId, code, reason: reason.toString() });
        });

        target.on('error', (error) => {
            console.error(`WebSocket ${connId} DmpConnect error: ${error.message}`);
        });
    }

    handleTunnelMessage(message) {
        const tunnel = this.tunnels.get(message.connId);
        if (!tunnel) {
            return;
        }
        const frame = message.binary ? Buffer.from(message.data, 'base64') : message.data;
        if (tunnel.target.readyState === WebSocket.OPEN) {
            tunnel.target.send(frame);
        } else if (tunnel.target.readyState === WebSocket.CONNECTING) {
            tunnel.queue.push(frame);
        }
    }

    handleTunnelClose(message) {
        const tunnel = this.tunnels.get(message.connId);
        if (!tunnel) {
            return;
        }
        this.tunnels.delete(message.connId);
        console.log(`WebSocket ${message.connId} closed by browser (code ${message.code})`);
        if (tunnel.target.readyState === WebSocket.CONNECTING) {
            tunnel.target.terminate();
        } else {
            tunnel.target.close(safeCloseCode(message.code), String(message.reason || '').slice(0, 120));
        }
    }

    async handleRequest(message) {
        console.log(`Processing request ${message.requestId}: ${message.method} ${message.path}`);
        
        try {
            const response = await this.forwardRequest(message);
            this.sendResponse(message.requestId, response);
        } catch (error) {
            console.error(`Error processing request ${message.requestId}:`, error);
            this.sendError(message.requestId, error.message);
        }
    }

    async forwardRequest(requestMessage) {
        const { method, path, headers, body, query, requestId } = requestMessage;
        const startedAt = Date.now();
        
        // Build the target URL
        const targetUrl = new URL(path, this.targetApiUrl);
        
        // Add query parameters
        if (query) {
            Object.entries(query).forEach(([key, value]) => {
                targetUrl.searchParams.append(key, value);
            });
        }
        
        // Prepare request options
        const options = {
            method: method,
            headers: {
                ...headers
            },
            timeout: 100000 
        };

        // Remove problematic headers
        delete options.headers['host'];
        delete options.headers['content-length'];
        delete options.headers['sec-websocket-key'];
        delete options.headers['sec-websocket-version'];
        delete options.headers['sec-websocket-extensions'];
        delete options.headers['upgrade'];
        delete options.headers['connection'];

        const bodyKeys = body && typeof body === 'object' ? Object.keys(body) : [];
        const contentType = (headers && (headers['content-type'] || headers['Content-Type'])) || 'none';
        console.log(`Forwarding ${requestId} ${method} ${targetUrl.href} content-type=${contentType} bodyKeys=${bodyKeys.join(',') || 'none'}`);
        if ((method === 'POST' || method === 'PUT' || method === 'PATCH') && bodyKeys.length === 0) {
            console.log(`Warning ${requestId}: ${method} forwarded with an empty body`);
        }

        return new Promise((resolve, reject) => {
            const isHttps = targetUrl.protocol === 'https:';
            const httpModule = isHttps ? https : http;
            
            // Add SSL options for HTTPS requests to bypass certificate verification
            if (isHttps) {
                options.rejectUnauthorized = false; // Bypass SSL certificate verification
            }
            
            const req = httpModule.request(targetUrl, options, (res) => {
                let responseBody = '';
                
                res.on('data', (chunk) => {
                    responseBody += chunk;
                });
                
                res.on('end', () => {
                    let parsedBody = responseBody;
                    
                    // Try to parse JSON if content-type suggests it
                    const contentType = res.headers['content-type'] || '';
                    if (contentType.includes('application/json') && responseBody) {
                        try {
                            parsedBody = JSON.parse(responseBody);
                        } catch (e) {
                            // Keep as string if parsing fails
                        }
                    }
                    
                    const elapsed = Date.now() - startedAt;
                    console.log(`DmpConnect ${requestId} HTTP ${res.statusCode} in ${elapsed}ms ${describeApiBody(parsedBody)}`);

                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: parsedBody
                    });
                });
            });

            req.on('error', (error) => {
                const elapsed = Date.now() - startedAt;
                console.error(`Request error for ${requestId} after ${elapsed}ms:`, error);
                reject(error);
            });

            req.on('timeout', () => {
                const elapsed = Date.now() - startedAt;
                console.error(`Request timeout for ${requestId} after ${elapsed}ms`);
                req.destroy();
                reject(new Error('Request timeout'));
            });

            // Send request body if present
            if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
                if (typeof body === 'object') {
                    req.write(JSON.stringify(body));
                } else {
                    req.write(body);
                }
            }

            req.end();
        });
    }

    sendResponse(requestId, response) {
        const responseMessage = {
            type: 'response',
            requestId: requestId,
            statusCode: response.statusCode,
            headers: response.headers,
            body: response.body
        };

        this.ws.send(JSON.stringify(responseMessage));
        console.log(`${response.statusCode} response of ${requestId} sent.`);
    }

    sendError(requestId, error) {
        const errorMessage = {
            type: 'response',
            requestId: requestId,
            statusCode: 500,
            headers: { 'content-type': 'application/json' },
            body: { error: error }
        };

        this.ws.send(JSON.stringify(errorMessage));
        console.log(`Error response ${requestId} sent: ${error}`);
    }
}

// Configuration
const SERVER_URL = process.env.RELAY_SERVER_URL || 'ws://card-reader-env.eba-azfgrdve.eu-central-1.elasticbeanstalk.com/';
const TARGET_API_URL = process.env.TARGET_API_URL || 'https://localhost.icanopee.net:9982';

// Start the master proxy
const masterProxy = new MasterProxy(SERVER_URL, TARGET_API_URL);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down master proxy...');
    if (masterProxy.ws) {
        masterProxy.ws.close();
    }
    process.exit(0);
});
