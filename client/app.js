const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

class ClientProxy {
    constructor(serverUrl, localPort = 9983) {
        this.serverUrl = serverUrl;
        this.localPort = localPort;
        this.app = express();
        this.server = http.createServer(this.app);
        this.ws = null;
        this.pendingRequests = new Map();
        this.isConnected = false;
        
        this.setupExpress();
        this.connectToServer();
    }

    setupExpress() {
        // Middleware
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
        
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
            
            // Register as client
            this.ws.send(JSON.stringify({
                type: 'register',
                role: 'client',
                clientId: `client_${uuidv4()}`
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
                console.log(`Registered as ${message.role} with ID: ${message.clientId}`);
                break;
                
            case 'response':
                this.handleResponse(message);
                break;
                
            case 'error':
                this.handleError(message);
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
        
        // Store the response object for later use
        this.pendingRequests.set(requestId, res);
        
        // Set timeout for request (30 seconds)
        const timeout = setTimeout(() => {
            if (this.pendingRequests.has(requestId)) {
                this.pendingRequests.delete(requestId);
                res.status(504).json({ error: 'Request timeout' });
            }
        }, 30000);

        // Store timeout for cleanup
        this.pendingRequests.get(requestId).timeout = timeout;

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
        console.log(`Request ${requestId} sent: ${req.method} ${req.path}`);
    }

    handleResponse(message) {
        const pendingRequest = this.pendingRequests.get(message.requestId);
        if (!pendingRequest) {
            console.log(`No pending request found for ID: ${message.requestId}`);
            return;
        }

        // Clear timeout
        if (pendingRequest.timeout) {
            clearTimeout(pendingRequest.timeout);
        }

        // Send response
        const res = pendingRequest;
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
        console.log(`Response ${message.requestId} sent to client`);
    }

    handleError(message) {
        const pendingRequest = this.pendingRequests.get(message.requestId);
        if (!pendingRequest) {
            console.log(`No pending request found for error ID: ${message.requestId}`);
            return;
        }

        // Clear timeout
        if (pendingRequest.timeout) {
            clearTimeout(pendingRequest.timeout);
        }

        // Send error response
        const res = pendingRequest;
        res.status(500).json({ error: message.error });

        // Clean up
        this.pendingRequests.delete(message.requestId);
        console.log(`Error response ${message.requestId} sent to client`);
    }

    start() {
        this.server.listen(this.localPort, () => {
            console.log(`Client proxy server running on port ${this.localPort}`);
            console.log(`All requests will be forwarded to the relay server`);
        });
    }
}

// Configuration
const SERVER_URL = process.env.RELAY_SERVER_URL || 'ws://card-reader-env.eba-azfgrdve.eu-central-1.elasticbeanstalk.com/';
const LOCAL_PORT = process.env.CLIENT_PORT || 9983;

// Start the client proxy
const clientProxy = new ClientProxy(SERVER_URL, LOCAL_PORT);
clientProxy.start();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down client proxy...');
    if (clientProxy.ws) {
        clientProxy.ws.close();
    }
    clientProxy.server.close(() => {
        process.exit(0);
    });
});
