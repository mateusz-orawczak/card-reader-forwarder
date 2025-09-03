const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const { URL } = require('url');

class MasterProxy {
    constructor(serverUrl, targetApiUrl) {
        this.serverUrl = serverUrl;
        this.targetApiUrl = targetApiUrl;
        this.ws = null;
        this.isConnected = false;
        
        this.connectToServer();
    }

    connectToServer() {
        console.log(`Connecting to WebSocket server at ${this.serverUrl}...`);
        
        this.ws = new WebSocket(this.serverUrl);
        
        this.ws.on('open', () => {
            console.log('Connected to WebSocket server');
            this.isConnected = true;
            
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

        this.ws.on('close', () => {
            console.log('Disconnected from WebSocket server');
            this.isConnected = false;
            
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
                console.log(`Registered as ${message.role}`);
                break;
                
            case 'request':
                this.handleRequest(message);
                break;
                
            default:
                console.log('Unknown message type:', message.type);
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
        
        // Build the target URL
        const targetUrl = new URL(path, this.targetApiUrl);
        
        // Add query parameters
        if (query) {
            Object.entries(query).forEach(([key, value]) => {
                targetUrl.searchParams.append(key, value);
            });
        }

        console.log('headers', headers);
        console.log('targetUrl', targetUrl);
        
        // Prepare request options
        const options = {
            method: method,
            headers: {
                ...headers
            },
            timeout: 30000 // 30 second timeout
        };

        // Remove problematic headers
        delete options.headers['host'];
        delete options.headers['content-length'];
        delete options.headers['sec-websocket-key'];
        delete options.headers['sec-websocket-version'];
        delete options.headers['sec-websocket-extensions'];
        delete options.headers['upgrade'];
        delete options.headers['connection'];
        
        console.log('options', options);

        return new Promise((resolve, reject) => {
            const isHttps = targetUrl.protocol === 'https:';
            const httpModule = isHttps ? https : http;
            
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
                    
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: parsedBody
                    });
                });
            });

            req.on('error', (error) => {
                console.error(`Request error for ${requestId}:`, error);
                reject(error);
            });

            req.on('timeout', () => {
                console.error(`Request timeout for ${requestId}`);
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
        console.log(`Response ${requestId} sent: ${response.statusCode}`);
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
// const SERVER_URL = process.env.RELAY_SERVER_URL || 'ws://localhost:8080';
const SERVER_URL = process.env.RELAY_SERVER_URL || 'ws://card-reader-env.eba-azfgrdve.eu-central-1.elasticbeanstalk.com/';
// const TARGET_API_URL = process.env.TARGET_API_URL || 'http://localhost.icanopee.net:9982';
const TARGET_API_URL = process.env.TARGET_API_URL || 'http://localhost:8000/api/codes/scan';

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
