// File: ./src/index.js
'use strict';
module.exports = {
    register( /* { strapi } */) { },
    bootstrap({ strapi }) {
        const io = require("socket.io")(strapi.server.httpServer, {
            cors: {
                origin: "http://localhost:5173",
                methods: ["GET", "POST"],
                allowedHeaders: ["my-custom-header"],
                credentials: true,
            },
        });
        io.on("connection", function (socket) {
            console.log("A user connected");
            socket.on("get_sessions", async ({ userId }) => {
                console.log(`Fetching sessions for user ${userId}`);
                try {
                    const sessions = await strapi.entityService.findMany('api::chat-session.chat-session', {
                        filters: {
                            users_permissions_user: userId
                        },
                        populate: ['users_permissions_user', 'chat_messages']
                    });
                    console.log("Retrieved sessions:", JSON.stringify(sessions, null, 2));
                    const formattedSessions = sessions.map(session => ({
                        ...session,
                        id: session.id.toString(),
                        chat_messages: session.chat_messages.map(msg => ({
                            ...msg,
                            id: msg.id.toString(),
                            session: session.id.toString()
                        }))
                    }));
                    console.log("Sending formatted sessions:", JSON.stringify(formattedSessions, null, 2));
                    socket.emit("sessions_list", formattedSessions);
                }
                catch (error) {
                    console.error("Error fetching sessions:", error);
                    socket.emit("error", { message: "Failed to fetch sessions: " + error.message });
                }
            });
            socket.on("join_session", async ({ userId, sessionId }) => {
                console.log(`User ${userId} joining session ${sessionId || 'new'}`);
                try {
                    let session;
                    let isNewSession = false;
                    if (sessionId) {
                        const parsedSessionId = parseInt(sessionId, 10);
                        console.log(`Parsed sessionId: ${parsedSessionId}`);
                        if (isNaN(parsedSessionId)) {
                            throw new Error('Invalid session ID');
                        }
                        session = await strapi.entityService.findOne('api::chat-session.chat-session', parsedSessionId, {
                            populate: ['users_permissions_user', 'chat_messages']
                        });
                        if (!session) {
                            throw new Error('Session not found');
                        }
                    }
                    else {
                        session = await strapi.entityService.create('api::chat-session.chat-session', {
                            data: {
                                users_permissions_user: userId,
                                name: `Session ${Date.now()}`
                            }
                        });
                        isNewSession = true;
                    }
                    console.log(`Joined session:`, JSON.stringify(session, null, 2));
                    console.log(`Session ID (before toString): ${session.id}, type: ${typeof session.id}`);
                    const sessionIdString = isNewSession ? (session.id - 1).toString() : (session.id).toString();
                    console.log(`Session ID (after toString): ${sessionIdString}, type: ${typeof sessionIdString}`);
                    socket.join(`session_${sessionIdString}`);
                    let messages = isNewSession ? [] : session.chat_messages;
                    console.log(`Sending session_joined event with ${messages.length} messages`);
                    const sessionJoinedData = {
                        sessionId: sessionIdString,
                        messages: messages.map(msg => ({
                            id: msg.id.toString(),
                            sender: msg.users_permissions_user,
                            content: msg.content,
                            createdAt: msg.createdAt,
                            session: sessionIdString,
                            isServerMessage: msg.isServerMessage
                        }))
                    };
                    console.log("Emitting session_joined with data:", JSON.stringify(sessionJoinedData, null, 2));
                    socket.emit("session_joined", sessionJoinedData);
                }
                catch (error) {
                    console.error("Error joining session:", error);
                    socket.emit("error", { message: "Failed to join session: " + error.message });
                }
            });
            socket.on("send_message", async ({ userId, sessionId, message }) => {
                console.log(`Attempting to send message in session ${sessionId} from user ${userId}: ${message}`);
                try {
                    const parsedSessionId = parseInt(sessionId, 10);
                    console.log(`Parsed sessionId for send_message: ${parsedSessionId}`);
                    if (isNaN(parsedSessionId)) {
                        throw new Error('Invalid session ID');
                    }
                    const session = await strapi.entityService.findOne('api::chat-session.chat-session', parsedSessionId);
                    if (!session) {
                        throw new Error(`Chat session with id ${sessionId} does not exist`);
                    }
                    console.log(`Found session:`, JSON.stringify(session, null, 2));
                    const userMessage = await strapi.entityService.create('api::chat-message.chat-message', {
                        data: {
                            content: message,
                            users_permissions_user: userId,
                            messages: session.id,
                            isServerMessage: false
                        }
                    });
                    console.log(`User message created:`, JSON.stringify(userMessage, null, 2));
                    const populatedUserMessage = await strapi.entityService.findOne('api::chat-message.chat-message', userMessage.id, {
                        populate: ['users_permissions_user', 'messages']
                    });
                    console.log(`Emitting new_message event for user message`);
                    const userMessageData = {
                        id: populatedUserMessage.id.toString(),
                        sender: populatedUserMessage.users_permissions_user,
                        content: populatedUserMessage.content,
                        createdAt: populatedUserMessage.createdAt,
                        session: session.id.toString(),
                        isServerMessage: populatedUserMessage.populatedUserMessage
                    };
                    console.log("Emitting new_message with user message data:", JSON.stringify(userMessageData, null, 2));
                    io.to(`session_${session.id}`).emit("new_message", userMessageData);
                    const serverMessage = await strapi.entityService.create('api::chat-message.chat-message', {
                        data: {
                            content: `Echo: ${message}`,
                            users_permissions_user: null,
                            messages: session.id,
                            isServerMessage: true
                        }
                    });
                    console.log(`Server message created:`, JSON.stringify(serverMessage, null, 2));
                    const populatedServerMessage = await strapi.entityService.findOne('api::chat-message.chat-message', serverMessage.id, {
                        populate: ['messages']
                    });
                    console.log(`Emitting new_message event for server message`);
                    const serverMessageData = {
                        id: populatedServerMessage.id.toString(),
                        sender: { username: 'Server' },
                        content: populatedServerMessage.content,
                        createdAt: populatedServerMessage.createdAt,
                        session: session.id.toString(),
                        isServerMessage: populatedUserMessage.populatedUserMessage
                    };
                    console.log("Emitting new_message with server message data:", JSON.stringify(serverMessageData, null, 2));
                    io.to(`session_${session.id}`).emit("new_message", serverMessageData);
                    const updatedSession = await strapi.entityService.update('api::chat-session.chat-session', session.id, {
                        data: {
                            chat_messages: {
                                connect: [userMessage.id, serverMessage.id]
                            }
                        }
                    });
                    console.log(`Chat session updated:`, JSON.stringify(updatedSession, null, 2));
                }
                catch (error) {
                    console.error("Error sending message:", error);
                    socket.emit("error", { message: "Failed to send message: " + error.message });
                }
            });
            socket.on("leave_session", ({ userId, sessionId }) => {
                console.log(`User ${userId} left session ${sessionId}`);
                socket.leave(`session_${sessionId}`);
            });
            socket.on("disconnect", () => {
                console.log("A user disconnected");
            });
        });
    },
};
