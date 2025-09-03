const WebSocket = require('ws');
const http = require('http');

class WebSocketRelayServer {
    constructor(port = 8080) {
        this.port = port;
        this.clients = new Map(); // Store client connections
        this.master = null; // Store master connection
        this.requestId = 0;
        this.pendingRequests = new Map(); // Store pending requests waiting for responses
        
        this.setupServer();
    }

    setupServer() {
        this.server = http.createServer();
        this.wss = new WebSocket.Server({ server: this.server });

        this.wss.on('connection', (ws, req) => {
            console.log('New connection established');
            
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleMessage(ws, message);
                } catch (error) {
                    console.error('Error parsing message:', error);
                    ws.send(JSON.stringify({ error: 'Invalid JSON message' }));
                }
            });

            ws.on('close', () => {
                this.handleDisconnection(ws);
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.handleDisconnection(ws);
            });
        });

        this.server.listen(this.port, () => {
            console.log(`WebSocket relay server running on port ${this.port}`);
        });
    }

    handleMessage(ws, message) {
        switch (message.type) {
            case 'register':
                this.handleRegistration(ws, message);
                break;
            case 'request':
                this.handleRequest(ws, message);
                break;
            case 'response':
                this.handleResponse(ws, message);
                break;
            default:
                console.log('Unknown message type:', message.type);
        }
    }

    handleRegistration(ws, message) {
        if (message.role === 'master') {
            this.master = ws;
            console.log('Master computer registered');
            ws.send(JSON.stringify({ type: 'registered', role: 'master' }));
        } else if (message.role === 'client') {
            const clientId = message.clientId || `client_${Date.now()}`;
            this.clients.set(clientId, ws);
            ws.clientId = clientId;
            console.log(`Client registered with ID: ${clientId}`);
            ws.send(JSON.stringify({ type: 'registered', role: 'client', clientId }));
        }
    }

    handleRequest(ws, message) {
        if (!this.master) {
            ws.send(JSON.stringify({ 
                type: 'error', 
                requestId: message.requestId,
                error: 'Master computer not available' 
            }));
            return;
        }

        // Generate unique request ID if not provided
        const requestId = message.requestId || `req_${++this.requestId}_${Date.now()}`;
        
        // Store the request for response matching
        this.pendingRequests.set(requestId, {
            clientWs: ws,
            originalRequest: message
        });

        // Forward request to master
        const forwardMessage = {
            type: 'request',
            requestId: requestId,
            method: message.method,
            path: message.path,
            headers: message.headers,
            body: message.body,
            query: message.query
        };

        this.master.send(JSON.stringify(forwardMessage));
        console.log(`Request ${requestId} forwarded to master`);
    }

    handleResponse(ws, message) {
        if (ws !== this.master) {
            console.log('Response received from non-master connection');
            return;
        }

        const pendingRequest = this.pendingRequests.get(message.requestId);
        if (!pendingRequest) {
            console.log(`No pending request found for ID: ${message.requestId}`);
            return;
        }

        // Send response back to client
        const responseMessage = {
            type: 'response',
            requestId: message.requestId,
            statusCode: message.statusCode,
            headers: message.headers,
            body: message.body
        };

        pendingRequest.clientWs.send(JSON.stringify(responseMessage));
        
        // Clean up
        this.pendingRequests.delete(message.requestId);
        console.log(`Response ${message.requestId} sent to client`);
    }

    handleDisconnection(ws) {
        if (ws === this.master) {
            this.master = null;
            console.log('Master computer disconnected');
        } else if (ws.clientId) {
            this.clients.delete(ws.clientId);
            console.log(`Client ${ws.clientId} disconnected`);
        }

        // Clean up any pending requests from this connection
        for (const [requestId, pending] of this.pendingRequests.entries()) {
            if (pending.clientWs === ws) {
                this.pendingRequests.delete(requestId);
                console.log(`Cleaned up pending request ${requestId}`);
            }
        }
    }
}

// Start the server
const relayServer = new WebSocketRelayServer(process.env.PORT || 8080);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down WebSocket relay server...');
    relayServer.server.close(() => {
        process.exit(0);
    });
});
