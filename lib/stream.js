// Load modules

var Hapi = require('hapi');
var SocketIO = require('socket.io');
var Project = require('./project');
var Session = require('./session');


// Declare internals

var internals = {};


module.exports = internals.Manager = function (server) {

    this.updatesQueue = [];     // Updates queue

    // Sockets list

    this.socketsById = {};     // { _id_: { socket: _socket_, userId: _userId_ }, ... }
    this.idsByProject = {};    // { _projectId_: { _id_: true, ... }, ... }
    this.idsByUserId = {};     // { _userId_: { _id_: true, ... }, ... }
    this.projectsById = {};    // { _id_: { _projectId_: true, ... }, ... }

    this.io = SocketIO.listen(server, { 'log level': 0 });
    this.io.sockets.on('connection', internals.connection);

    setInterval(internals.processUpdates, 1000);
};


// Add update to queue

internals.Manager.prototype.update = function (update, request) {

    update.type = 'update';

    if (request) {
        if (request.auth.credentials.user) {
            update.by = request.auth.credentials.user;
        }

        if (request.auth.credentials &&
            request.auth.credentials.id) {

            update.macId = request.auth.credentials.id.slice(-8);
        }
    }

    this.updatesQueue.push(update);
};


// Subscribe

internals.Manager.prototype.subscribe = function () {

    var manager = this;

    return {
        handler: function (request, reply) {

            // Lookup socket

            if (!manager.socketsById[request.params.id] ||
                !manager.socketsById[request.params.id].socket) {

                return reply(Hapi.Error.notFound('Stream not found'));
            }

            if (!manager.socketsById[request.params.id].userId) {
                return reply(Hapi.Error.badRequest('Stream not initialized'));
            }

            if (manager.socketsById[request.params.id].userId !== request.auth.credentials.user) {
                return reply(Hapi.Error.forbidden());
            }

            var socket = manager.socketsById[request.params.id].socket;

            // Lookup project

            Project.load(this.db, request.params.project, request.auth.credentials.user, false, function (err, project, member) {

                if (err) {
                    return reply(err);
                }

                // Add to subscriber list

                manager.idsByProject[project._id] = manager.idsByProject[project._id] || {};
                manager.idsByProject[project._id][request.params.id] = true;

                // Add to cleanup list

                manager.projectsById[request.params.id] = manager.projectsById[request.params.id] || {};
                manager.projectsById[request.params.id][project._id] = true;

                // Send ack via the stream

                socket.json.send({ type: 'subscribe', project: project._id });

                // Send ack via the request

                return reply({ status: 'ok' });
            });
        }
    };
};


// Unsubscribe

internals.Manager.prototype.unsubscribe = function () {

    var manager = this;

    return {
        handler: function (request, reply) {

            // Lookup socket

            if (!manager.socketsById[request.params.id] ||
                !manager.socketsById[request.params.id].socket) {

                return reply(Hapi.Error.notFound('Stream not found'));
            }

            if (!manager.socketsById[request.params.id].userId) {
                return reply(Hapi.Error.badRequest('Stream not initialized'));
            }

            if (manager.socketsById[request.params.id].userId !== request.auth.credentials.user) {
                return reply(Hapi.Error.forbidden());
            }

            var socket = manager.socketsById[request.params.id].socket;

            // Remove from subscriber list

            if (!manager.idsByProject[request.params.project] ||
                !manager.idsByProject[request.params.project][request.params.id]) {

                return reply(Hapi.Error.notFound('Project subscription not found'));
            }

            delete manager.idsByProject[request.params.project][request.params.id];

            // Remove from cleanup list

            if (manager.projectsById[request.params.id]) {
                delete manager.projectsById[request.params.id][request.params.project];
            }

            // Send ack via the stream

            socket.json.send({ type: 'unsubscribe', project: request.params.project });

            // Send ack via the request

            return reply({ status: 'ok' });
        }
    };
};


// Force unsubscribe

internals.Manager.prototype.drop = function (userId, projectId) {

    var userIds = internals.idsByUserId[userId];
    if (userIds) {
        var projectIds = internals.idsByProject[projectId];
        if (projectIds) {
            for (var i in userIds) {
                if (userIds.hasOwnProperty(i)) {
                    if (projectIds[i]) {
                        delete internals.idsByProject[projectId][i];

                        // Send ack via the stream

                        if (internals.socketsById[i] &&
                            internals.socketsById[i].socket) {

                            internals.socketsById[i].socket.json.send({ type: 'unsubscribe', project: projectId });
                        }
                    }
                }
            }
        }
    }
};


// New Socket

internals.connection = function (socket) {

    // Add to sockets map

    internals.socketsById[socket.id] = { socket: socket };

    // Setup handlers

    socket.on('message', internals.messageHandler(socket));
    socket.on('disconnect', internals.disconnectHandler(socket));

    // Send session id

    socket.json.send({ type: 'connect', session: socket.id });
};


// Stream message handler

internals.messageHandler = function (socket) {

    return function (message) {

        var connection = internals.socketsById[socket.id];
        if (connection) {
            if (message) {
                switch (message.type) {
                    case 'initialize':
                        if (!message.authorization) {
                            socket.json.send({ type: 'initialize', status: 'error', error: 'Missing authorization' });
                        }
                        else {
                            Session.validateMessage(socket.id, message.authorization, function (err, userId) {

                                if (userId) {
                                    connection.userId = userId;

                                    internals.idsByUserId[userId] = internals.idsByUserId[userId] || {};
                                    internals.idsByUserId[userId][socket.id] = true;

                                    socket.json.send({ type: 'initialize', status: 'ok', user: userId });
                                }
                                else {
                                    socket.json.send({ type: 'initialize', status: 'error', error: err });
                                }
                            });
                        }
                        break;

                    default:
                        socket.json.send({ type: 'error', error: 'Unknown message type: ' + message.type });
                        break;
                }
            }
        }
        else {
            // Message received after disconnect from socket
        }
    };
};


// Stream disconnection handler

internals.disconnectHandler = function (socket) {

    return function () {

        if (internals.socketsById[socket.id]) {
            var userId = internals.socketsById[socket.id].userId;

            // Remove from users list

            if (userId) {
                delete internals.idsByUserId[userId];
            }

            // Remove from sockets list

            delete internals.socketsById[socket.id];
        }

        // Remove from subscribers list

        var projects = internals.projectsById[socket.id];
        if (projects) {
            for (var i in projects) {
                if (projects.hasOwnProperty(i)) {
                    if (internals.idsByProject[i]) {
                        delete internals.idsByProject[i][socket.id];
                    }
                }
            }
        }

        // Remove from cleanup list

        delete internals.projectsById[socket.id];
    };
};


// Updates interval

internals.processUpdates = function () {

    for (var i = 0, il = internals.updatesQueue.length; i < il; ++i) {
        var update = internals.updatesQueue[i];
        var updatedIds = '';

        switch (update.object) {
            case 'project':
            case 'tasks':
            case 'task':
            case 'details':

                // Lookup project list

                var ids = internals.idsByProject[update.project];
                if (ids) {
                    for (var s in ids) {
                        if (ids.hasOwnProperty(s)) {
                            if (internals.socketsById[s] &&
                                internals.socketsById[s].socket) {

                                internals.socketsById[s].socket.json.send(update);
                                updatedIds += ' ' + s;
                            }
                        }
                    }
                }

                break;

            case 'profile':
            case 'contacts':
            case 'projects':

                var ids = internals.idsByUserId[update.user];
                if (ids) {
                    for (var s in ids) {
                        if (ids.hasOwnProperty(s)) {
                            if (internals.socketsById[s] &&
                                internals.socketsById[s].socket) {

                                internals.socketsById[s].socket.json.send(update);
                                updatedIds += ' ' + s;
                            }
                        }
                    }
                }

                break;
        }
    }

    internals.updatesQueue = [];
};


