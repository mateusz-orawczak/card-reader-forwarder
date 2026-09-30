const WebSocket = require('ws');
const http = require('http');

class WebSocketRelayServer {
    constructor(port = 8080) {
        this.port = port;
        this.clients = new Map(); // Store client connections
        this.master = null; // Store master connection
        this.requestId = 0;
        this.pendingRequests = new Map(); // Store pending requests waiting for responses
        this.tunnels = new Map(); // WebSocket tunnel id -> client connection that opened it
        
        this.setupServer();
    }

    setupServer() {
        this.server = http.createServer();
        this.wss = new WebSocket.Server({ server: this.server });

        this.wss.on('connection', (ws, req) => {
            console.log('New connection established');
            ws.isAlive = true;
            ws.on('pong', () => {
                ws.isAlive = true;
            });
            
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleMessage(ws, message);
                } catch (error) {
                    console.error('Error parsing message:', error);
                    ws.send(JSON.stringify({ error: 'Invalid JSON message' }));
                }
            });

            ws.on('close', (code, reason) => {
                ws.closeCode = code;
                ws.closeReason = reason && reason.length ? reason.toString() : 'none';
                this.handleDisconnection(ws);
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.handleDisconnection(ws);
            });
        });

        // Elastic Beanstalk closes WebSockets that are idle for ~60s.
        // Ping inside that window so nginx and the load balancer see traffic.
        this.heartbeat = setInterval(() => {
            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    console.log('Terminating connection that missed a heartbeat');
                    ws.terminate();
                    return;
                }

                ws.isAlive = false;
                ws.ping();
            });
        }, 25000);

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
            case 'ws_open':
                this.handleTunnelOpen(ws, message);
                break;
            case 'ws_message':
            case 'ws_close':
                this.relayTunnelFrame(ws, message);
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
        if (!this.master || this.master.readyState !== WebSocket.OPEN) {
            console.error(`Request ${message.requestId} dropped: master not connected (${message.method} ${message.path})`);
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
            originalRequest: message,
            forwardedAt: Date.now()
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
        console.log(`Request ${requestId} forwarded to master: ${message.method} ${message.path}`);
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
        const elapsed = Date.now() - pendingRequest.forwardedAt;
        this.pendingRequests.delete(message.requestId);
        console.log(`Response ${message.requestId} HTTP ${message.statusCode} sent to client in ${elapsed}ms`);
    }

    handleTunnelOpen(ws, message) {
        if (!this.master || this.master.readyState !== WebSocket.OPEN) {
            console.error(`WebSocket tunnel ${message.connId} refused: master not connected (${message.path})`);
            ws.send(JSON.stringify({
                type: 'ws_close',
                connId: message.connId,
                code: 1011,
                reason: 'Master computer not available'
            }));
            return;
        }

        this.tunnels.set(message.connId, ws);
        this.master.send(JSON.stringify(message));
        console.log(`WebSocket tunnel ${message.connId} forwarded to master: ${message.path}`);
    }

    relayTunnelFrame(ws, message) {
        const clientWs = this.tunnels.get(message.connId);
        if (!clientWs) {
            return;
        }

        const target = ws === this.master ? clientWs : this.master;
        if (target && target.readyState === WebSocket.OPEN) {
            target.send(JSON.stringify(message));
        }

        if (message.type === 'ws_close') {
            this.tunnels.delete(message.connId);
            console.log(`WebSocket tunnel ${message.connId} closed by ${ws === this.master ? 'master' : 'client'} (code ${message.code})`);
        }
    }

    handleDisconnection(ws) {
        const closeDetail = `code ${ws.closeCode}, reason: ${ws.closeReason || 'none'}`;
        const wasMaster = ws === this.master;
        if (wasMaster) {
            this.master = null;
            console.log(`Master computer disconnected (${closeDetail})`);
        } else if (ws.clientId) {
            this.clients.delete(ws.clientId);
            console.log(`Client ${ws.clientId} disconnected (${closeDetail})`);
        }

        for (const [connId, clientWs] of this.tunnels.entries()) {
            if (wasMaster) {
                this.tunnels.delete(connId);
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ type: 'ws_close', connId, code: 1011, reason: 'Master computer disconnected' }));
                }
            } else if (clientWs === ws) {
                this.tunnels.delete(connId);
                if (this.master && this.master.readyState === WebSocket.OPEN) {
                    this.master.send(JSON.stringify({ type: 'ws_close', connId, code: 1001, reason: 'Client disconnected' }));
                }
            }
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
    clearInterval(relayServer.heartbeat);
    relayServer.server.close(() => {
        process.exit(0);
    });
});
